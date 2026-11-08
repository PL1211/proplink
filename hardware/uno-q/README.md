# Connect the UNO Q to BuildingConnect

## Join Wi-Fi

Connect the UNO Q to your computer with a USB-C data cable and open Arduino App Lab. Select the board and use the Wi-Fi step during first-time setup. If the board is already set up, use the network icon on its Linux desktop or run these commands in the board's terminal. `--ask` prompts for the password interactively.

```sh
nmcli radio wifi on
nmcli device wifi list
sudo nmcli --ask device wifi connect "YOUR_NETWORK_NAME"
nmcli device status
```

The Wi-Fi device should show `connected`. For a LAN test, join the same network as the Windows computer. [Arduino UNO Q networking](https://docs.arduino.cc/tutorials/uno-q/debian-guide/)

## Give the board a backend address

Use the hosted backend at `https://buildingconnect.vercel.app`. From the UNO Q terminal, run `curl https://buildingconnect.vercel.app/api/config` to verify it can reach the server.

For a local test on a trusted private network, run `ipconfig` in Windows PowerShell and find the IPv4 address of the Wi-Fi adapter. From the BuildingConnect repo, start a second listener using that address. Replace the example IP below with your computer's IP.

```powershell
npm.cmd run build
$env:HOST = '192.168.1.25'
$env:PORT = '5175'
npm.cmd start
```

In the UNO Q terminal, run `curl http://192.168.1.25:5175/api/config` using the same IP. A JSON response confirms the board can reach the server. If it times out, check Windows Firewall access for Node.js on the private network and whether the Wi-Fi isolates devices. Use this HTTP setup only for the local bench test.

## Send the first real reading

1. Create an App in Arduino App Lab or duplicate your existing App. Copy [the sketch](sketch/sketch.ino) into its `sketch/sketch.ino` and [the uploader](python/main.py) into its `python/main.py`. Keep the sketch libraries for Servo and Arduino RouterBridge in the App's sketch profile.
2. In the App's Python folder, create `device.json` alongside `main.py`. Use the backend base URL you tested and copy only `DEVICE_TOKEN` from the Windows repo's ignored `.env`. Keep this file local to the board's App.

   ```json
   {
     "backend_url": "https://buildingconnect.vercel.app",
     "device_token": "paste the DEVICE_TOKEN value here"
   }
   ```

3. Click **Run** in App Lab. Look for **Sent reading** in the Python console and check **Sensor Data** in the dashboard for both buildings. Compare the temperature sensor counts to the Serial Monitor. [Running and monitoring an App](https://docs.arduino.cc/software/app-lab/apps/run/)

The office sends ambient light, thermistor counts, and fan status. The data center sends flame sensor status, thermistor counts, and fan status. The heat flag is based on a change from the startup baseline or the thermistor module's digital output. During the bench test, confirm the flame module's active level against the Serial Monitor; the sketch uses `HIGH` as active.

The sketch keeps the supplied pin assignments, always-on LEDs, and servo behavior. Fan status reflects the controller's request to move the servo. Fan speed and actual movement are not measured. The dashboard only monitors the hardware.

## Calibrate the KY-028 temperature sensors

1. Put a reference thermometer next to each module. Let the reading settle, then record the thermometer's temperature and the average `temp=` count from the Serial Monitor for each building. `temp=` is a raw count; `base=` is the startup count.
2. Repeat at a different stable temperature. Choose two temperatures that bracket the range you want to display. Additional reference points can improve estimates over a wider range.
3. Set `THERMISTOR_CALIBRATION` in the backend environment with separate profiles for `office` and `data_center`. Each profile takes `adc_max` (1023 for the included sketch) and `points` of `{ "raw": 510, "celsius": 20 }`. These numbers are examples; enter measured pairs. See [`.env.example`](../../.env.example) for the JSON format. Redeploy after setting it in Vercel. The UNO Q keeps uploading the same raw counts.

With multiple references, the dashboard estimates Celsius and Fahrenheit between calibrated points. It shows raw counts outside that range or when a sensor has no calibration. Keep the setup and the KY-028 dial fixed while collecting references. [KY-028 module documentation](https://sensorkit.joy-it.net/en/sensors/ky-028)

For a rough room-temperature estimate, a profile can use a single `reference` object with `raw` and `celsius` in place of `points`. This assumes a KY-028 whose analog count falls as it warms and whose divider supply matches the ADC reference. The dashboard marks these values as estimates from the room reference and shows raw counts beyond 10 °C from it.
