/*
  Smart Environmental Monitoring Station - Arduino side
  ----------------------------------------------------
  Pins:
    DHT11 DATA  -> D2
    LDR divider -> A0   (5V -> LDR -> A0 -> 10k -> GND)
    Green LED   -> D8   (through 220 ohm)
    Red LED     -> D9   (through 220 ohm)
    Buzzer (+)  -> D10  (active buzzer)
    LCD SDA     -> A4
    LCD SCL     -> A5

  Libraries (Arduino IDE -> Tools -> Manage Libraries):
    - "DHT sensor library" by Adafruit
    - "Adafruit Unified Sensor" by Adafruit
    - "LiquidCrystal I2C" by Frank de Brabander

  Serial protocol (9600 baud, one line per message):
    Arduino -> laptop:
      HELLO,ENVMON,1
      DATA,<tempC>,<humidity%>,<lightRaw 0-1023>,<NORMAL|ALERT>
      LIMITS,<tempLimit>,<humLimit>
      MUTE,<0|1>
      ERR,DHT
    Laptop -> Arduino:
      LIMITS,<tempLimit>,<humLimit>
      MUTE,<0|1>
      PING
*/

#include <DHT.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// ---------- Pins ----------
#define DHTPIN     2
#define DHTTYPE    DHT11     // change to DHT22 if you use a DHT22
#define LDRPIN     A0
#define GREEN_LED  8
#define RED_LED    9
#define BUZZER     10

// ---------- Settings ----------
#define USE_LCD        1      // set to 0 if you don't have the LCD
#define LCD_ADDRESS    0x27   // try 0x3F if the screen stays blank
const unsigned long READ_INTERVAL_MS = 2000;  // DHT11 needs >= 1 s between reads

float tempLimit = 35.0;   // degrees C
float humLimit  = 80.0;   // percent
bool  muted     = false;

DHT dht(DHTPIN, DHTTYPE);
#if USE_LCD
LiquidCrystal_I2C lcd(LCD_ADDRESS, 16, 2);
#endif

unsigned long lastRead = 0;
bool alertActive = false;
char cmdBuf[48];
byte cmdLen = 0;

void sendLimits() {
  Serial.print(F("LIMITS,"));
  Serial.print(tempLimit, 1);
  Serial.print(',');
  Serial.println(humLimit, 1);
}

void sendMute() {
  Serial.print(F("MUTE,"));
  Serial.println(muted ? 1 : 0);
}

void handleCommand(char *line) {
  if (strncmp(line, "LIMITS,", 7) == 0) {
    char *p = line + 7;
    char *comma = strchr(p, ',');
    if (comma) {
      *comma = '\0';
      float t = atof(p);
      float h = atof(comma + 1);
      if (t > 0 && t < 80) tempLimit = t;
      if (h > 0 && h <= 100) humLimit = h;
    }
    sendLimits();
  } else if (strncmp(line, "MUTE,", 5) == 0) {
    muted = (line[5] == '1');
    if (muted) digitalWrite(BUZZER, LOW);
    sendMute();
  } else if (strcmp(line, "PING") == 0) {
    Serial.println(F("HELLO,ENVMON,1"));
    sendLimits();
    sendMute();
  }
}

void readSerialCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdLen > 0) {
        cmdBuf[cmdLen] = '\0';
        handleCommand(cmdBuf);
        cmdLen = 0;
      }
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    }
  }
}

// Beep pattern while alerting: 200 ms on, 800 ms off (non-blocking)
void updateBuzzer() {
  if (!alertActive || muted) {
    digitalWrite(BUZZER, LOW);
    return;
  }
  digitalWrite(BUZZER, (millis() % 1000) < 200 ? HIGH : LOW);
}

void takeReading() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  int light = analogRead(LDRPIN);

  if (isnan(t) || isnan(h)) {
    Serial.println(F("ERR,DHT"));
#if USE_LCD
    lcd.setCursor(0, 0);
    lcd.print(F("DHT11 error!    "));
    lcd.setCursor(0, 1);
    lcd.print(F("Check D2 wiring "));
#endif
    return;
  }

  // Hysteresis: once alerting, clear only when 0.5 C / 2 % below the limit,
  // so the DHT11's small jitter can't make the buzzer flicker on and off.
  if (alertActive) {
    alertActive = (t > tempLimit - 0.5 || h > humLimit - 2.0);
  } else {
    alertActive = (t > tempLimit || h > humLimit);
  }
  digitalWrite(GREEN_LED, alertActive ? LOW : HIGH);
  digitalWrite(RED_LED,   alertActive ? HIGH : LOW);

  Serial.print(F("DATA,"));
  Serial.print(t, 1);
  Serial.print(',');
  Serial.print(h, 1);
  Serial.print(',');
  Serial.print(light);
  Serial.print(',');
  Serial.println(alertActive ? F("ALERT") : F("NORMAL"));

#if USE_LCD
  // Line 1: "T:28.4C H:61%   "
  lcd.setCursor(0, 0);
  lcd.print(F("T:"));
  lcd.print(t, 1);
  lcd.print(F("C H:"));
  lcd.print(h, 0);
  lcd.print(F("%    "));
  // Line 2: "L:73%   NORMAL  "
  lcd.setCursor(0, 1);
  lcd.print(F("L:"));
  lcd.print(map(light, 0, 1023, 0, 100));
  lcd.print(F("%  "));
  lcd.setCursor(8, 1);
  lcd.print(alertActive ? F("ALERT!  ") : F("NORMAL  "));
#endif
}

void setup() {
  Serial.begin(9600);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  dht.begin();

#if USE_LCD
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print(F("Env Monitor"));
  lcd.setCursor(0, 1);
  lcd.print(F("Starting..."));
#endif

  // Quick self-test so you can see every output works
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, HIGH);
  digitalWrite(BUZZER, HIGH);
  delay(150);
  digitalWrite(BUZZER, LOW);
  delay(450);
  digitalWrite(RED_LED, LOW);

  Serial.println(F("HELLO,ENVMON,1"));
  sendLimits();
  sendMute();
}

void loop() {
  readSerialCommands();

  if (millis() - lastRead >= READ_INTERVAL_MS) {
    lastRead = millis();
    takeReading();
  }

  updateBuzzer();
}
