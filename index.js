/**
 * Firebase Cloud Functions - backend pro rezervační systém Difference Goalies.
 *
 * Proč tady a ne v appce: odesílání e-mailů (Resend), sync s Google Calendar API
 * a Stripe platby potřebují tajné API klíče, které nesmí být v Android appce.
 * Appka volá pouze tyto callable funkce, nikdy napřímo cizí API.
 *
 * Nastavení klíčů:
 *   firebase functions:config:set resend.key="re_xxx" \
 *     stripe.secret="sk_xxx" stripe.webhook_secret="whsec_xxx" \
 *     google.calendar_id="xxx@group.calendar.google.com"
 *   (a servisní účet Google pro Calendar API nahraj jako secret GOOGLE_SERVICE_ACCOUNT_JSON)
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const { Resend } = require("resend");
const { v4: uuidv4 } = require("uuid");

admin.initializeApp();
const db = admin.firestore();

const resend = new Resend(functions.config().resend?.key);
const CALENDAR_ID = functions.config().google?.calendar_id;
const TRAINER_EMAIL = "mikojakub@gmail.com";
const REGION = "europe-west1";

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

/**
 * Vypočítá volné sloty pro daný den a službu:
 * 1) vezme týdenní rozvrh + blokace
 * 2) odečte existující rezervace ve Firestore
 * 3) odečte busy časy z Google Kalendáře (obousměrný sync - pokud trenér
 *    přidá do Google Kalendáře vlastní událost, slot zmizí i tady)
 */
exports.getAvailableSlots = functions.region(REGION).https.onCall(async (data) => {
  const { date, serviceId } = data; // date = "yyyy-MM-dd"
  const dayOfWeek = new Date(date + "T00:00:00").getDay() === 0 ? 7 : new Date(date + "T00:00:00").getDay();

  const [serviceDoc, weeklySnap, blockedSnap, bookingsSnap] = await Promise.all([
    db.collection("services").doc(serviceId).get(),
    db.collection("weeklyAvailability").where("dayOfWeek", "==", dayOfWeek).get(),
    db.collection("blockedPeriods").where("date", "==", date).get(),
    db.collection("bookings").where("date", "==", date).where("status", "==", "CONFIRMED").get(),
  ]);

  if (!serviceDoc.exists || weeklySnap.empty) return [];
  const durationMin = serviceDoc.data().durationMinutes;
  const availability = weeklySnap.docs[0].data();
  const blockedFullDay = blockedSnap.docs.some((d) => !d.data().startTime);
  if (blockedFullDay) return [];

  const takenRanges = [
    ...bookingsSnap.docs.map((d) => ({ start: d.data().startTime, end: d.data().endTime })),
    ...blockedSnap.docs
      .filter((d) => d.data().startTime)
      .map((d) => ({ start: d.data().startTime, end: d.data().endTime })),
  ];

  // Busy časy z Google Kalendáře přes freebusy
  let googleBusy = [];
  if (CALENDAR_ID) {
    try {
      const calendar = getCalendarClient();
      const timeMin = `${date}T00:00:00`;
      const timeMax = `${date}T23:59:59`;
      const fb = await calendar.freebusy.query({
        requestBody: { timeMin, timeMax, items: [{ id: CALENDAR_ID }] },
      });
      googleBusy = (fb.data.calendars[CALENDAR_ID]?.busy || []).map((b) => ({
        start: b.start.slice(11, 16),
        end: b.end.slice(11, 16),
      }));
    } catch (e) {
      console.error("Google Calendar freebusy selhalo, pokračuju bez něj:", e.message);
    }
  }

  const allBusy = [...takenRanges, ...googleBusy];
  const slots = [];
  let cursor = availability.startTime;
  while (addMinutes(cursor, durationMin) <= availability.endTime) {
    const slotEnd = addMinutes(cursor, durationMin);
    const overlaps = allBusy.some((b) => cursor < b.end && slotEnd > b.start);
    slots.push({ startTime: cursor, endTime: slotEnd, isAvailable: !overlaps });
    cursor = addMinutes(cursor, availability.slotLengthMinutes);
  }
  return slots;
});

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  const nh = Math.floor(total / 60) % 24;
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

/**
 * Vytvoří rezervaci uvnitř Firestore transakce, aby dva klienti nemohli
 * ve stejnou chvíli obsadit stejný slot (race condition).
 */
exports.createBooking = functions.region(REGION).https.onCall(async (data) => {
  const { serviceId, date, startTime, client, manageToken } = data;

  const serviceDoc = await db.collection("services").doc(serviceId).get();
  if (!serviceDoc.exists) throw new functions.https.HttpsError("not-found", "Služba neexistuje.");
  const service = serviceDoc.data();
  const endTime = addMinutes(startTime, service.durationMinutes);

  const bookingRef = db.collection("bookings").doc();

  await db.runTransaction(async (tx) => {
    const conflictSnap = await tx.get(
      db.collection("bookings")
        .where("date", "==", date)
        .where("status", "==", "CONFIRMED")
    );
    const conflict = conflictSnap.docs.some(
      (d) => startTime < d.data().endTime && endTime > d.data().startTime
    );
    if (conflict) {
      throw new functions.https.HttpsError("already-exists", "Tento termín je už obsazený, vyber prosím jiný.");
    }
    tx.set(bookingRef, {
      id: bookingRef.id,
      serviceId,
      serviceName: service.name,
      date,
      startTime,
      endTime,
      client,
      status: "CONFIRMED",
      manageToken: manageToken || uuidv4(),
      createdAtMillis: Date.now(),
      paid: false,
    });
  });

  const booking = (await bookingRef.get()).data();

  // Založit událost v Google Kalendáři (a uložit její ID pro pozdější sync/zrušení)
  if (CALENDAR_ID) {
    try {
      const calendar = getCalendarClient();
      const event = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: `${service.name} – ${client.name}`,
          description: `Cíl: ${client.goalNote || "-"}\nZdravotní omezení: ${client.healthNote || "-"}\nTel: ${client.phone}`,
          start: { dateTime: `${date}T${startTime}:00`, timeZone: "Europe/Prague" },
          end: { dateTime: `${date}T${endTime}:00`, timeZone: "Europe/Prague" },
        },
      });
      await bookingRef.update({ googleCalendarEventId: event.data.id });
    } catch (e) {
      console.error("Založení Google Calendar eventu selhalo:", e.message);
    }
  }

  await sendBookingEmails(booking);

  return { bookingId: bookingRef.id };
});

exports.cancelBooking = functions.region(REGION).https.onCall(async (data) => {
  const { manageToken } = data;
  const snap = await db.collection("bookings").where("manageToken", "==", manageToken).limit(1).get();
  if (snap.empty) throw new functions.https.HttpsError("not-found", "Rezervace nenalezena.");

  const doc = snap.docs[0];
  const booking = doc.data();

  const bookingStart = new Date(`${booking.date}T${booking.startTime}:00+02:00`);
  const hoursUntil = (bookingStart.getTime() - Date.now()) / 3_600_000;
  const MIN_CANCEL_HOURS = 24;
  if (hoursUntil < MIN_CANCEL_HOURS) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Rezervaci lze zrušit nejpozději ${MIN_CANCEL_HOURS} hodin předem.`
    );
  }

  await doc.ref.update({ status: "CANCELLED" });

  if (CALENDAR_ID && booking.googleCalendarEventId) {
    try {
      const calendar = getCalendarClient();
      await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: booking.googleCalendarEventId });
    } catch (e) {
      console.error("Smazání Google Calendar eventu selhalo:", e.message);
    }
  }

  await resend.emails.send({
    from: "Difference Goalies <rezervace@differencegoalies.cz>",
    to: [booking.client.email, TRAINER_EMAIL],
    subject: "Rezervace zrušena",
    html: `<p>Rezervace ${booking.date} ${booking.startTime} byla zrušena.</p>`,
  });

  return { success: true };
});

async function sendBookingEmails(booking) {
  const ics = buildIcs(booking);
  const commonHtml = `
    <p>${booking.serviceName}</p>
    <p>${booking.date}, ${booking.startTime}–${booking.endTime}</p>
    <p>Klient: ${booking.client.name}, ${booking.client.phone}</p>
  `;

  await resend.emails.send({
    from: "Difference Goalies <rezervace@differencegoalies.cz>",
    to: [booking.client.email],
    subject: "Potvrzení rezervace tréninku",
    html: `${commonHtml}<p>Pro zrušení/přesun použij odkaz: https://booking.differencegoalies.cz/manage/${booking.manageToken}</p>`,
    attachments: [{ filename: "trenink.ics", content: Buffer.from(ics).toString("base64") }],
  });

  await resend.emails.send({
    from: "Difference Goalies <rezervace@differencegoalies.cz>",
    to: [TRAINER_EMAIL],
    subject: `Nová rezervace: ${booking.client.name}`,
    html: commonHtml,
    attachments: [{ filename: "trenink.ics", content: Buffer.from(ics).toString("base64") }],
  });
}

function buildIcs(booking) {
  const dt = (t) => `${booking.date.replace(/-/g, "")}T${t.replace(":", "")}00`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${booking.id}@differencegoalies.cz`,
    `DTSTART:${dt(booking.startTime)}`,
    `DTEND:${dt(booking.endTime)}`,
    `SUMMARY:${booking.serviceName}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/**
 * Plánovaná funkce - jednou za hodinu zkontroluje rezervace ~24h dopředu
 * a pošle klientovi připomínku, pokud ještě nebyla odeslána.
 */
exports.sendReminders = functions.region(REGION).pubsub.schedule("every 60 minutes").onRun(async () => {
  const in24h = new Date(Date.now() + 24 * 3_600_000);
  const dateStr = in24h.toISOString().slice(0, 10);

  const snap = await db.collection("bookings")
    .where("date", "==", dateStr)
    .where("status", "==", "CONFIRMED")
    .where("reminderSent", "==", false)
    .get();

  for (const doc of snap.docs) {
    const booking = doc.data();
    await resend.emails.send({
      from: "Difference Goalies <rezervace@differencegoalies.cz>",
      to: [booking.client.email],
      subject: "Připomínka: trénink zítra",
      html: `<p>Připomínáme trénink ${booking.date} v ${booking.startTime}.</p>`,
    });
    await doc.ref.update({ reminderSent: true });
  }
});

/**
 * Stripe webhook - nastav v Stripe dashboardu URL na tuto funkci,
 * event checkout.session.completed. Označí rezervaci jako zaplacenou.
 */
exports.stripeWebhook = functions.region(REGION).https.onRequest(async (req, res) => {
  const stripe = require("stripe")(functions.config().stripe?.secret);
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      req.headers["stripe-signature"],
      functions.config().stripe?.webhook_secret
    );
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata?.bookingId;
    if (bookingId) {
      await db.collection("bookings").doc(bookingId).update({
        paid: true,
        stripePaymentIntentId: session.payment_intent,
      });
    }
  }

  res.json({ received: true });
});
