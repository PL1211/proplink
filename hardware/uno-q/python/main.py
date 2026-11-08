"""Arduino App Lab uploader for the BuildingConnect UNO Q sketch."""

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


class Uploader:
    def __init__(self, backend_url, device_token):
        self.url = backend_url.rstrip("/") + "/api/hardware/telemetry"
        self.token = device_token
        self.boot_id = str(uuid4())
        self.sequence = 0
        self.uptime = None
        self.reported_activations = 0

    def payload(self, reading):
        uptime = reading["uptime_ms"]
        if self.uptime is not None and uptime < self.uptime:
            self.boot_id = str(uuid4())
            self.sequence = 0
            self.reported_activations = 0
        self.uptime = uptime

        payload = {
            "schema_version": 1,
            "device_id": "unoq-main",
            "boot_id": self.boot_id,
            "sequence": self.sequence,
            "mcu_uptime_ms": uptime,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "source": "hardware",
            "buildings": {
                "office": {
                    "sensors": {"light": {
                        "raw": reading["light"], "adc_max": 1023, "unit": "adc_counts",
                    }},
                    "commanded": {
                        "leds": [True, True, True],
                        "fan": "running" if reading["office_fan"] else "stopped",
                    },
                },
                "data_center": {
                    "sensors": {"flame_ir": {
                        "digital_level": reading["ir_level"],
                        "ir_alert": bool(reading["ir_active"]),
                        "alert_seen_since_last_report":
                            reading["ir_activations"] != self.reported_activations,
                    }},
                    "commanded": {
                        "leds": [True, True, True],
                        "fan": "running" if reading["dc_fan"] else "stopped",
                    },
                },
            },
        }
        for building, prefix in (("office", "office"), ("data_center", "dc")):
            raw_key, hot_key = f"{prefix}_temp_raw", f"{prefix}_hot"
            if raw_key in reading and hot_key in reading:
                payload["buildings"][building]["sensors"]["thermistor"] = {
                    "raw": reading[raw_key], "adc_max": 1023, "unit": "adc_counts",
                    "hot": bool(reading[hot_key]),
                }
        return payload

    def send(self, reading):
        payload = self.payload(reading)
        self.sequence += 1
        request = Request(
            self.url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        request.add_unredirected_header("Authorization", "Bearer " + self.token)
        with urlopen(request, timeout=2) as response:
            result = json.load(response)
        if result.get("current"):
            self.reported_activations = reading["ir_activations"]
            print(f"Sent reading {payload['sequence']} (office light: {reading['light']})", flush=True)
        else:
            print("Reading stored without updating live state. Check the board clock.", flush=True)


def main():
    from arduino.app_utils import App, Bridge

    config_path = Path(__file__).with_name("device.json")
    if not config_path.is_file():
        raise SystemExit("Create python/device.json with backend_url and device_token.")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    uploader = Uploader(config["backend_url"], config["device_token"])

    def loop():
        try:
            reading = json.loads(Bridge.call("buildingconnect_snapshot"))
            uploader.send(reading)
        except HTTPError as error:
            print(f"Backend rejected upload (HTTP {error.code}).", flush=True)
        except (URLError, TimeoutError):
            print("Backend unreachable. Check its URL and the board's network.", flush=True)
        except Exception as error:
            print(f"Could not read or upload the UNO Q snapshot ({type(error).__name__}).", flush=True)
        time.sleep(1)

    App.run(user_loop=loop)


if __name__ == "__main__":
    main()
