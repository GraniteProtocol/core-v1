import { fetchCallReadOnlyFunction, cvToJSON, bufferCV, principalCV, listCV } from "@stacks/transactions";
import fs from "node:fs";

const ADAPTER = "SPSX722NK9V3A8D3CVQT0CDY4EBQ3E9FSDDE61FT.pyth-adapter-v1";
const SENDER = "SP000000000000000000002Q6VF78";
const TOKENS = [
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
  "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
];

const [contractAddress, contractName] = ADAPTER.split(".");
const blob = JSON.parse(fs.readFileSync("/tmp/pyth-gov-update.json", "utf8")).evm;
const bytes = Uint8Array.from(Buffer.from(blob.replace(/^0x/, ""), "hex"));

const base = { contractAddress, contractName, senderAddress: SENDER, network: "mainnet" };

const verifiedRes = await fetchCallReadOnlyFunction({
  ...base, functionName: "verify-update", functionArgs: [bufferCV(bytes)],
});
const verifiedJson = cvToJSON(verifiedRes);
console.log("verify-update type:", verifiedRes.type, "success:", verifiedJson.success);
console.log("verify-update:", JSON.stringify(verifiedJson).slice(0, 500));

if (!verifiedJson.success) {
  console.log("RESULT: FAIL - verify-update did not return ok");
  process.exit(1);
}

const pricesRes = await fetchCallReadOnlyFunction({
  ...base, functionName: "prices-for",
  functionArgs: [verifiedRes.value, listCV(TOKENS.map((t) => principalCV(t)))],
});
console.log("prices-for:", JSON.stringify(cvToJSON(pricesRes)).slice(0, 600));

const pricesJson = cvToJSON(pricesRes);
console.log("prices-for success:", pricesJson.success);
const ok = pricesJson.success === true;
console.log("RESULT:", ok ? "PASS - price read works" : "FAIL - prices-for did not return ok");
process.exit(ok ? 0 : 1);
