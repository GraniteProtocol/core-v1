import json
import tomllib
import urllib.request

CFG = "/Users/vedhavyas/Projects/granite-backend/api/config.toml"
URL = "https://pyth-lazer.dourolabs.app/v1/latest_price"

cfg = tomllib.load(open(CFG, "rb"))
token = cfg["envs"]["staging"]["pyth_api_key"]

body = json.dumps({
    "priceFeedIds": [1, 7],
    "properties": ["price", "exponent", "publisherCount"],
    "formats": ["evm"],
    "channel": "fixed_rate@1000ms",
    "jsonBinaryEncoding": "hex",
}).encode()

req = urllib.request.Request(
    URL,
    data=body,
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
)

try:
    with urllib.request.urlopen(req, timeout=30) as r:
        status = r.status
        payload = json.loads(r.read())
except urllib.error.HTTPError as e:
    print("HTTPError", e.code)
    print(e.read()[:300])
    raise SystemExit(1)

print("status:", status)
print("top-level keys:", sorted(payload.keys()))
f = payload.get("evm") or {}
data = f.get("data")
print("evm keys:", sorted(f.keys()))
print("data prefix:", (data or "")[:20], "len:", len(data or ""))
print("feed ids in response:", payload.get("priceFeedIds") or payload.get("parsed", {}).get("priceFeeds") and [x.get("priceFeedId") for x in payload["parsed"]["priceFeeds"]])

if data:
    open("/tmp/pyth-gov-update.json", "w").write(json.dumps({"evm": data}))
    print("wrote /tmp/pyth-gov-update.json")
else:
    print("NO evm data; full keys:", json.dumps(payload)[:600])
