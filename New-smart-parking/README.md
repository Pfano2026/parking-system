# SmartPark IoT – Smart Parking System (ESP32)

TUT · IDC30BI / PJD301B · Raphunga Pfano Vincent (221328868)

```
smart-parking/
├── public/index.html     website (customer portal, email inbox, admin dashboard, API tab)
├── package.json          Node dependencies
├── schema.sql            database (PostgreSQL) – runs automatically on start
├── server.js             web server + API for the website and the ESP32
└── smart_parking.ino     ESP32 code (IR sensors, keypad, 2 servos, OLED)
```

## How it works

1. Customer opens the website, picks a green bay, enters name, email and number plate.
2. The server saves the booking in the database, makes a 4-digit PIN and **emails it**. The same email also shows in the website's **Email Inbox** tab.
3. At the keypad the customer types the PIN and presses `#` → **entry gate opens**, session starts.
4. To leave, the customer types the **same PIN** and presses `#` → **exit gate opens**, session ends and the fee is saved.
5. The ESP32 sends its 4 IR sensor readings to the server every 3 s. That is also the heartbeat: if the server gets nothing for 12 s the website shows **ESP32 Offline**, otherwise **ESP32 Online**.

Bay colours: green = available, yellow = reserved (booked, PIN not used yet), red = occupied (IR sensor sees a vehicle).
Fee = hourly rate × started hours (minimum 1 hour). An unused reservation is released after 30 minutes.

---

## Step 1 – Put the folder on GitHub

1. Create a new repository on github.com (name: `smart-parking`).
2. Upload all files keeping the `public` folder (GitHub → *Add file → Upload files*, drag the whole folder contents), or use git:
   ```
   git init
   git add .
   git commit -m "SmartPark IoT"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/smart-parking.git
   git push -u origin main
   ```

## Step 2 – Database on Render

1. Render dashboard → **New → PostgreSQL**. Name `smart-parking-db`, choose the free plan, create.
2. Open it and copy the **Internal Database URL** (use the *External* one only if the web service is in another region).
3. The tables are created automatically from `schema.sql` when the server starts. Nothing to import by hand.

> Free Render databases expire after a limited time. Check the expiry date in the Render dashboard before your final presentation.

## Step 3 – Website on Render

1. **New → Web Service** → connect your GitHub repo.
2. Runtime **Node**, Build command `npm install`, Start command `npm start`.
3. **Environment variables**

| Name | Value |
|---|---|
| `DATABASE_URL` | the Internal Database URL from step 2 |
| `ESP32_API_KEY` | any secret text, e.g. `pfano-parking-2026` (same text goes in the `.ino`) |
| `ADMIN_USER` / `ADMIN_PASS` | your admin login (default `admin` / `admin123` – change it) |
| `SESSION_SECRET` | any long random text |
| `BREVO_API_KEY` | for real emails (step 4) |
| `MAIL_FROM` | your verified sender email (step 4) |

4. Deploy. Open `https://<your-service>.onrender.com`. The header shows **ESP32 Offline** until the ESP32 connects.

The free web service sleeps after 15 minutes without traffic. While the ESP32 is powered it calls the server every 3 s, so it stays awake. Before presenting, open the site once to wake it.

## Step 4 – Real PIN emails (Brevo)

Render's free web services block the normal email ports (SMTP 25/465/587), so Gmail/SMTP will not work on the free plan. This project uses Brevo's web API instead, which does work:

1. Create a free account at brevo.com.
2. **Senders & IP → Senders** → add and verify your email address (e.g. your Gmail).
3. **SMTP & API → API keys** → create a key.
4. In Render add `BREVO_API_KEY` (the key) and `MAIL_FROM` (the verified sender email). Redeploy.

Without these two variables the system still works: every PIN email is saved and shown in the **Email Inbox** tab, so you can demo it either way.

## Step 5 – ESP32

1. Install the libraries listed at the top of `smart_parking.ino` (ArduinoJson 7.x, Keypad, ESP32Servo, Adafruit SSD1306 + GFX).
2. Edit: `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL` (your Render link) and `API_KEY` (same as `ESP32_API_KEY`).
3. Board **ESP32 Dev Module** → Upload → Serial Monitor 115200.

### Wiring

| Part | ESP32 pin |
|---|---|
| IR sensor Bay 1 / 2 / 3 / 4 (OUT) | GPIO 34 / 35 / 32 / 33 |
| Entry servo signal | GPIO 25 |
| Exit servo signal | GPIO 26 |
| OLED SDA / SCL | GPIO 21 / 22 |
| Keypad rows | GPIO 19, 18, 5, 17 |
| Keypad columns | GPIO 16, 4, 27, 14 |
| Buzzer (+) | GPIO 23 |

* Power the IR sensors from **3.3 V** so their output never exceeds the ESP32's 3.3 V limit.
* Power both servos from a separate **5 V** supply and join its GND to the ESP32 GND. Do not power servos from the ESP32 pin.
* No pin is used twice (the old GPIO 18 servo/keypad conflict is gone).
* If a bay shows occupied when empty, set `IR_ACTIVE_LOW` to `false`.

## Test checklist (before presenting)

1. Website opens, header says **ESP32 Online** once the ESP32 is powered. Unplug it: after about 12 s it says **ESP32 Offline**.
2. Book Bay 1 → PIN email arrives (and shows in Email Inbox). Bay 1 turns yellow.
3. Type the PIN + `#` at the keypad → entry servo opens 4 s, OLED says WELCOME. Admin table shows `active`.
4. Put an object in front of the Bay 1 IR sensor → Bay 1 turns red.
5. Type the same PIN + `#` → exit servo opens, OLED shows the fee, status becomes `completed`, revenue updates.
6. Admin Dashboard → close the booking system → Book Now buttons are disabled. Open it again.
7. Admin Dashboard → Open entry gate / Open exit gate → servo moves.
8. Export CSV downloads `parking_logs.csv`.

No ESP32 at hand? Switch to the demo: the **Hardware IR Simulator** on the Customer Portal toggles bay sensors while the ESP32 is offline.

## Security notes

* Change `ADMIN_PASS`, `ESP32_API_KEY` and `SESSION_SECRET` before showing the site publicly.
* Customers find their own booking through a private token kept in their browser, so nobody can read another person's PIN email.
