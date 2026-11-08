// Two Buildings model on one Arduino UNO Q
// Office:      thermistor D0 (D2) + A0 (A1), Grove light sensor (A0), servo (D9), 3 white LEDs (D5, D6, D11)
// Data center: thermistor D0 (D3) + A0 (A5), flame sensor (D4), servo (D10), 3 green LEDs (A2, A3, A4)


#include <Servo.h>
#include <Arduino_RouterBridge.h>  // gives the UNO Q its "Monitor" output


const uint8_t TEMP_D0_PIN[2]  = {2, 3};      // module "D0" pin: office, data center
const uint8_t TEMP_ANA_PIN[2] = {A1, A5};    // module "A0" pin: office, data center
const uint8_t LIGHT_PIN       = A0;           // office Grove light sensor
const uint8_t FLAME_PIN       = 4;            // data center flame module D0
const uint8_t SERVO_PIN[2]    = {9, 10};
const uint8_t OFFICE_LED[3]   = {5, 6, 11};   // white
const uint8_t DC_LED[3]       = {A2, A3, A4}; // green


// Servos: set to false to stop them completely
const bool SERVOS_ENABLED = true;


// Thermistor: "hot" when the analog reading moves HOT_DELTA away from the
// startup baseline, OR when the module's D0 pin reads the hot level.
const int HOT_DELTA = 15;
const int HYST      = 10;
const int TEMP_D0_HOT_LEVEL = LOW;   // flip to HIGH if D0 reads backwards


// Office light sensor (Grove reads HIGHER when bright)
const int  LIGHT_THRESHOLD = 300;    // 0 to 1023
const bool BRIGHT_IS_HIGH  = true;


// Flame module D0 level that means "flame"
const int FLAME_ACTIVE_LEVEL = HIGH;


// Print local diagnostics once per second.
const unsigned long PRINT_MS = 1000;

// Servo movement: flips between LOW_ANGLE and HIGH_ANGLE every MOVE_MS
const int LOW_ANGLE  = 10;
const int HIGH_ANGLE = 170;
const unsigned long MOVE_MS = 500;
const bool FORCE_SWEEP[2] = {true, true};   // true = always moving, false = only when hot/fire
Servo servo[2];
bool  flipState[2] = {false, false};
unsigned long lastMove[2] = {0, 0};


int   raw[2]      = {0, 0};     // analog temp reading, 0 to 1023
int   baseline[2] = {0, 0};     // analog reading at startup
int   d0[2]       = {0, 0};     // D0 level
bool  hot[2]      = {false, false};
bool  deltaHot[2] = {false, false};
int   lightRaw    = 0;
bool  officeLit   = false;
int   flameLevel  = 0;
bool  fire        = false;


unsigned long lastRead = 0;
unsigned long irActivations = 0;


int readAveraged(uint8_t pin) {
 long sum = 0;
 for (int k = 0; k < 8; k++) { sum += analogRead(pin); delay(1); }
 return sum / 8;
}


String snapshot();
void readSensors();

void setup() {
 Bridge.begin();
 Monitor.begin();
 analogReadResolution(10);  // readings 0 to 1023
 pinMode(FLAME_PIN, INPUT);
 pinMode(TEMP_D0_PIN[0], INPUT);
 pinMode(TEMP_D0_PIN[1], INPUT);


 if (SERVOS_ENABLED) {
   for (int i = 0; i < 2; i++) {
     servo[i].attach(SERVO_PIN[i]);
     servo[i].write(LOW_ANGLE);
   }
 }


 // Office white LEDs and data center green LEDs, always on
 for (int k = 0; k < 3; k++) {
   pinMode(OFFICE_LED[k], OUTPUT);
   digitalWrite(OFFICE_LED[k], HIGH);
   pinMode(DC_LED[k], OUTPUT);
   digitalWrite(DC_LED[k], HIGH);
 }


 // Baseline = room temperature right now (reset the board to re-take it)
 delay(500);
 for (int i = 0; i < 2; i++) baseline[i] = readAveraged(TEMP_ANA_PIN[i]);
 readSensors();
 if (!Bridge.provide_safe("buildingconnect_snapshot", snapshot)) {
   Monitor.println("Could not register BuildingConnect Bridge method");
 }
}


void readSensors() {
 for (int i = 0; i < 2; i++) {
   raw[i] = readAveraged(TEMP_ANA_PIN[i]);
   int change = abs(raw[i] - baseline[i]);
   if (change >= HOT_DELTA) deltaHot[i] = true;
   else if (change <= HOT_DELTA - HYST) deltaHot[i] = false;
   d0[i]  = digitalRead(TEMP_D0_PIN[i]);
   hot[i] = deltaHot[i] || (d0[i] == TEMP_D0_HOT_LEVEL);
 }
 lightRaw   = analogRead(LIGHT_PIN);
 officeLit  = BRIGHT_IS_HIGH ? (lightRaw > LIGHT_THRESHOLD)
                             : (lightRaw < LIGHT_THRESHOLD);
 flameLevel = digitalRead(FLAME_PIN);
 fire       = (flameLevel == FLAME_ACTIVE_LEVEL);
}


// A room needs its vent moving when FORCE_SWEEP is on for it,
// or it is hot, or on fire (data center)
bool needsVent(int i) {
 return FORCE_SWEEP[i] || hot[i] || (i == 1 && fire);
}


void moveServos() {
 unsigned long now = millis();
 for (int i = 0; i < 2; i++) {
   if (needsVent(i)) {
     if (now - lastMove[i] >= MOVE_MS) {
       lastMove[i] = now;
       flipState[i] = !flipState[i];
       servo[i].write(flipState[i] ? HIGH_ANGLE : LOW_ANGLE);
     }
   } else if (flipState[i]) {
     flipState[i] = false;
     servo[i].write(LOW_ANGLE);
   }
 }
}


// Readable lines for you
void report() {
 Monitor.print("Office: temp=");
 Monitor.print(raw[0]);
 Monitor.print(" base=");
 Monitor.print(baseline[0]);
 Monitor.print(" hot=");
 Monitor.print(hot[0]);
 Monitor.print(" d0=");
 Monitor.print(d0[0]);
 Monitor.print(", light=");
 Monitor.print(lightRaw);
 Monitor.println(officeLit ? " (on)" : " (dark)");


 Monitor.print("DataCenter: temp=");
 Monitor.print(raw[1]);
 Monitor.print(" base=");
 Monitor.print(baseline[1]);
 Monitor.print(" hot=");
 Monitor.print(hot[1]);
 Monitor.print(" d0=");
 Monitor.print(d0[1]);
 Monitor.print(", flame pin=");
 Monitor.print(flameLevel);
 Monitor.println(fire ? " FLAME DETECTED" : " no flame");
}


// Read IR on each loop so short activations can be included in the next upload.
void sampleIr() {
 flameLevel = digitalRead(FLAME_PIN);
 bool active = flameLevel == FLAME_ACTIVE_LEVEL;
 if (active && !fire) irActivations++;
 fire = active;
}

// The Python process on the UNO Q reads this through Arduino Bridge.
String snapshot() {
 char json[260];
 snprintf(json, sizeof(json),
          "{\"uptime_ms\":%lu,\"light\":%d,\"ir_level\":%d,\"ir_active\":%d,\"ir_activations\":%lu,"
          "\"office_fan\":%d,\"dc_fan\":%d,\"office_temp_raw\":%d,\"office_hot\":%d,\"dc_temp_raw\":%d,\"dc_hot\":%d}",
          millis(), lightRaw, flameLevel, fire, irActivations,
          SERVOS_ENABLED && needsVent(0), SERVOS_ENABLED && needsVent(1),
          raw[0], hot[0], raw[1], hot[1]);
 return String(json);
}

void loop() {
 sampleIr();
 unsigned long now = millis();
 if (now - lastRead >= PRINT_MS) {
   lastRead = now;
   readSensors();
   sampleIr();
   report();
 }
 if (SERVOS_ENABLED) moveServos();
}
