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

Use your deployed HTTPS backend URL if available. For a temporary test on a trusted private network, run `ipconfig` in Windows PowerShell and find the IPv4 address of the Wi-Fi adapter. From the BuildingConnect repo, start a second listener using that address. Replace the example IP below with your computer's IP.

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
     "backend_url": "http://192.168.1.25:5175",
     "device_token": "paste the DEVICE_TOKEN value here"
   }
   ```

3. Click **Run** in App Lab. Look for **Sent reading** in the Python console and check the dashboard for live readings. The Serial Monitor still prints raw thermistor counts for local debugging. [Running and monitoring an App](https://docs.arduino.cc/software/app-lab/apps/run/)

The starter sends office light and data-center IR readings. It retains the supplied pin assignments, always-on LEDs, and servo behavior. Confirm the flame module's active level against the Serial Monitor during the bench test. The sketch still uses `HIGH` as active. Dashboard LED and fan commands need a separate device handler.
