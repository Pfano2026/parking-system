/* =====================================================================
   SmartPark IoT - ESP32 firmware (smart_parking.ino)

   Hardware : ESP32 DevKit, 4x IR obstacle sensors (one per bay), 4x4 keypad,
              2x SG90 servos (entry gate + exit gate), 0.96" I2C OLED (SSD1306),
              active buzzer.
   Website  : the Render site (see SERVER_URL). The ESP32 only makes outgoing
              HTTPS calls, so no port forwarding is needed.

   LIBRARIES (Arduino IDE > Sketch > Include Library > Manage Libraries):
     - ArduinoJson        by Benoit Blanchon  (version 7.x)
     - Keypad             by Mark Stanley, Alexander Brevig
     - ESP32Servo         by Kevin Harrington, John K. Bennett
     - Adafruit SSD1306   (+ Adafruit GFX Library, Adafruit BusIO)
   BOARD: "ESP32 Dev Module"  |  Serial Monitor: 115200 baud

   HOW IT WORKS
     every 3 s  -> POST /api/esp32/sync   : sends the 4 IR readings (this is also the
                   "heartbeat" that makes the website show ESP32 Online), receives
                   bay states and manual gate commands from the admin dashboard.
     keypad PIN -> POST /api/esp32/verify-pin :
                   first time the PIN is used  -> entry gate opens (session starts)
                   second time the same PIN    -> exit gate opens (session ends, fee)
   ===================================================================== */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Keypad.h>
#include <ESP32Servo.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ======================= 1. YOUR SETTINGS (edit these) =======================
const char* WIFI_SSID  = "YOUR_WIFI_NAME";
const char* WIFI_PASS  = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "https://smart-parking-ugzq.onrender.com";   // no slash at the end
const char* API_KEY    = "smartpark-esp32-key";   // must equal ESP32_API_KEY on Render

// ======================= 2. PINS =======================
// IR sensors (OUT pin). Most IR modules (FC-51 style) give LOW when a vehicle is detected.
const int  IR_PINS[4]     = {34, 35, 32, 33};
const bool IR_ACTIVE_LOW  = true;       // set false if your module gives HIGH when it sees a vehicle
const unsigned long IR_DEBOUNCE_MS = 300;

const int SERVO_ENTRY_PIN = 25;
const int SERVO_EXIT_PIN  = 26;
const int BUZZER_PIN      = 23;
// OLED I2C: SDA = GPIO 21, SCL = GPIO 22
const int OLED_ADDR = 0x3C;

const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[ROWS] = {19, 18, 5, 17};
byte colPins[COLS] = {16, 4, 27, 14};

// ======================= 3. GATE SETTINGS =======================
const int  CLOSED_ANGLE[2] = {0, 0};     // [0] = entry gate, [1] = exit gate
const int  OPEN_ANGLE[2]   = {90, 90};   // change to 90/0 style values if one servo is mounted mirrored
const unsigned long GATE_OPEN_MS = 4000; // gate stays open for 4 seconds

const unsigned long SYNC_MS = 3000;

// ======================= objects & state =======================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);
Servo gateServo[2];
WiFiClientSecure secureClient;
HTTPClient http;

bool irRaw[4]    = {false, false, false, false};
bool irStable[4] = {false, false, false, false};
unsigned long irChangedAt[4] = {0, 0, 0, 0};

int serverBay[4] = {0, 0, 0, 0};          // from the website: 0 available, 1 reserved, 2 occupied

bool gateIsOpen[2] = {false, false};
unsigned long gateCloseAt[2] = {0, 0};

String pinBuf = "";
unsigned long lastKeyAt = 0;

unsigned long lastSync = 0, lastOkSync = 0, lastWifiTry = 0, lastDraw = 0;
bool forceSync = true;

String ovTitle = "", ovSub = "";
unsigned long ovUntil = 0;

// ======================= helpers =======================
void beep(int ms) {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(ms);
  digitalWrite(BUZZER_PIN, LOW);
}

bool serverOnline() {
  return lastOkSync != 0 && (millis() - lastOkSync) < 10000;
}

void showOverlay(const String& title, const String& sub, unsigned long ms) {
  ovTitle = title;
  ovSub = sub;
  ovUntil = millis() + ms;
}

void centerText(const String& text, int y, int size) {
  int16_t x1, y1;
  uint16_t w, h;
  display.setTextSize(size);
  display.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  display.setCursor((128 - w) / 2, y);
  display.print(text);
}

// ======================= OLED screens =======================
void drawMain() {
  display.clearDisplay();

  // title bar
  display.fillRect(0, 0, 128, 13, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  centerText("SMART PARKING", 3, 1);
  display.setTextColor(SSD1306_WHITE);

  // what each bay shows: IR sensor wins, then the website booking state
  int freeCount = 0;
  int shown[4];
  for (int i = 0; i < 4; i++) {
    shown[i] = irStable[i] ? 2 : (serverBay[i] == 1 ? 1 : 0);
    if (shown[i] == 0) freeCount++;
  }

  // free spaces (left)
  display.setTextSize(1);
  display.setCursor(12, 18);
  display.print("FREE");
  display.setTextSize(3);
  display.setCursor(14, 30);
  display.print(freeCount);

  // bay boxes (right): outline = free, R = reserved, filled = occupied
  for (int i = 0; i < 4; i++) {
    int x = 66 + (i % 2) * 32;
    int y = 17 + (i / 2) * 19;
    display.setTextSize(1);
    if (shown[i] == 2) {
      display.fillRoundRect(x, y, 28, 16, 3, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
      display.setCursor(x + 11, y + 4);
      display.print(i + 1);
      display.setTextColor(SSD1306_WHITE);
    } else {
      display.drawRoundRect(x, y, 28, 16, 3, SSD1306_WHITE);
      display.setCursor(shown[i] == 1 ? x + 8 : x + 11, y + 4);
      if (shown[i] == 1) display.print("R");
      display.print(i + 1);
    }
  }

  // bottom line
  display.setTextSize(1);
  if (pinBuf.length() > 0) {
    String s = "PIN: ";
    for (int i = 0; i < 4; i++) s += (i < (int)pinBuf.length()) ? '*' : '_';
    centerText(s, 55, 1);
  } else if (WiFi.status() != WL_CONNECTED) {
    centerText("NO WI-FI", 55, 1);
  } else if (!serverOnline()) {
    centerText("SERVER OFFLINE", 55, 1);
  } else {
    centerText("ENTER PIN + #", 55, 1);
  }
  display.display();
}

void drawOverlay() {
  display.clearDisplay();
  display.drawRect(0, 0, 128, 64, SSD1306_WHITE);
  centerText(ovTitle, 14, 2);
  if (ovSub.length()) centerText(ovSub, 40, 1);
  display.display();
}

void drawScreen(bool force = false) {
  if (!force && millis() - lastDraw < 250) return;
  lastDraw = millis();
  if (millis() < ovUntil) drawOverlay();
  else drawMain();
}

// ======================= gates =======================
void openGate(int g) {
  gateServo[g].write(OPEN_ANGLE[g]);
  gateIsOpen[g] = true;
  gateCloseAt[g] = millis() + GATE_OPEN_MS;
}

void handleGates() {
  for (int g = 0; g < 2; g++) {
    if (gateIsOpen[g] && millis() >= gateCloseAt[g]) {
      gateServo[g].write(CLOSED_ANGLE[g]);
      gateIsOpen[g] = false;
    }
  }
}

// ======================= network =======================
int postJson(const char* path, const String& body, String& response) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  String url = String(SERVER_URL) + path;
  http.begin(secureClient, url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  int code = http.POST(body);
  if (code > 0) response = http.getString();
  http.end();
  return code;
}

void maintainWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 10000) return;
  lastWifiTry = millis();
  Serial.println("Wi-Fi lost, reconnecting...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void syncWithServer() {
  lastSync = millis();
  forceSync = false;

  JsonDocument doc;
  JsonArray arr = doc["bays"].to<JsonArray>();
  for (int i = 0; i < 4; i++) arr.add(irStable[i]);
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  String body, resp;
  serializeJson(doc, body);

  int code = postJson("/api/esp32/sync", body, resp);
  if (code != 200) {
    Serial.printf("Sync failed (HTTP %d)\n", code);
    return;
  }
  JsonDocument res;
  if (deserializeJson(res, resp)) return;
  lastOkSync = millis();

  for (int i = 0; i < 4; i++) {
    const char* s = res["bays"][i];
    if (!s) continue;
    serverBay[i] = !strcmp(s, "occupied") ? 2 : (!strcmp(s, "reserved") ? 1 : 0);
  }
  for (JsonVariant c : res["commands"].as<JsonArray>()) {
    const char* t = c.as<const char*>();
    if (!t) continue;
    if (!strcmp(t, "open_entry")) { openGate(0); showOverlay("ENTRY GATE", "OPENED BY ADMIN", 2500); beep(150); }
    if (!strcmp(t, "open_exit"))  { openGate(1); showOverlay("EXIT GATE",  "OPENED BY ADMIN", 2500); beep(150); }
  }
}

void submitPin() {
  showOverlay("CHECKING", "PLEASE WAIT", 8000);
  drawScreen(true);

  JsonDocument doc;
  doc["pin"] = pinBuf;
  String body, resp;
  serializeJson(doc, body);
  int code = postJson("/api/esp32/verify-pin", body, resp);
  ovUntil = 0;

  if (code != 200) {
    showOverlay("OFFLINE", "SERVER NOT REACHED", 2500);
    beep(400);
    return;
  }
  JsonDocument res;
  if (deserializeJson(res, resp)) {
    showOverlay("ERROR", "TRY AGAIN", 2000);
    return;
  }
  if (!(res["ok"] | false)) {
    showOverlay("WRONG PIN", "ACCESS DENIED", 2500);
    beep(120); delay(80); beep(120); delay(80); beep(120);
    return;
  }
  const char* action = res["action"] | "";
  int gate = res["gate"] | 0;
  int bay = res["bay"] | 0;
  openGate(gate);
  beep(200);
  if (!strcmp(action, "exit")) {
    float fee = res["fee"] | 0.0;
    char buf[24];
    snprintf(buf, sizeof(buf), "FEE R%.2f", fee);
    showOverlay("THANK YOU", String(buf), 3500);
  } else {
    char buf[24];
    snprintf(buf, sizeof(buf), "BAY %d - GATE OPEN", bay);
    showOverlay("WELCOME", String(buf), 3500);
  }
  forceSync = true;
}

// ======================= inputs =======================
void readIR() {
  for (int i = 0; i < 4; i++) {
    int level = digitalRead(IR_PINS[i]);
    bool raw = IR_ACTIVE_LOW ? (level == LOW) : (level == HIGH);
    if (raw != irRaw[i]) { irRaw[i] = raw; irChangedAt[i] = millis(); }
    if (irStable[i] != irRaw[i] && millis() - irChangedAt[i] >= IR_DEBOUNCE_MS) {
      irStable[i] = irRaw[i];
      forceSync = true;   // tell the website straight away
      Serial.printf("Bay %d: %s\n", i + 1, irStable[i] ? "OCCUPIED" : "free");
    }
  }
}

void readKeypad() {
  if (pinBuf.length() > 0 && millis() - lastKeyAt > 15000) pinBuf = "";   // forget half-typed PIN
  char k = keypad.getKey();
  if (!k) return;
  lastKeyAt = millis();
  beep(25);
  if (k >= '0' && k <= '9') {
    if (pinBuf.length() < 4) pinBuf += k;
  } else if (k == '*') {
    pinBuf = "";
  } else if (k == '#') {
    if (pinBuf.length() == 4) submitPin();
    else showOverlay("PIN = 4 DIGITS", "TRY AGAIN", 1500);
    pinBuf = "";
  }
}

// ======================= setup / loop =======================
void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  for (int i = 0; i < 4; i++) pinMode(IR_PINS[i], INPUT);

  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED not found - check SDA 21 / SCL 22 and address 0x3C");
  }
  display.setTextColor(SSD1306_WHITE);
  display.clearDisplay();
  centerText("SMART PARKING", 10, 1);
  centerText("Starting...", 30, 1);
  display.display();

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  gateServo[0].setPeriodHertz(50);
  gateServo[1].setPeriodHertz(50);
  gateServo[0].attach(SERVO_ENTRY_PIN, 500, 2400);
  gateServo[1].attach(SERVO_EXIT_PIN, 500, 2400);
  gateServo[0].write(CLOSED_ANGLE[0]);
  gateServo[1].write(CLOSED_ANGLE[1]);

  secureClient.setInsecure();      // skip certificate check (fine for a student prototype)
  http.setReuse(true);
  http.setTimeout(6000);
  http.setConnectTimeout(6000);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  display.clearDisplay();
  centerText("Connecting Wi-Fi", 28, 1);
  display.display();
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Wi-Fi connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi not connected yet - will keep trying.");
  }
  beep(100);
}

void loop() {
  readIR();
  readKeypad();
  handleGates();
  maintainWiFi();
  if (forceSync || millis() - lastSync >= SYNC_MS) syncWithServer();
  drawScreen();
}
