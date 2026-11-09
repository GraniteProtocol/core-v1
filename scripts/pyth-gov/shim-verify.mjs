import { fetchCallReadOnlyFunction, cvToJSON, principalCV, bufferCV } from "@stacks/transactions";

const ORACLE = "SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-oracle";
const SHIM = "SPA105SQJJSN4YCZXR9F1C6GYQE8DRZ95WNY5HZF.pyth-lazer-gov";
const SENDER = "SP000000000000000000002Q6VF78";
const GUARDIANS = [
  "SP1ABZHX4VKG0BTQ8NTBJ591W7AK67C33KR76QD27",
  "SPTXMEW26M54HX1ZXF6VN7QKK4XES1038ERD40T5",
  "SP2G62YGCCMWS4PAN54ZYT2G9TCJRGBSKQ679M96Q",
  "SP2EBZVFF99Q97GJXGTRT3Y0M7N6G7XJAKMNVGFK",
];

async function ro(contract, fn, args = []) {
  const [contractAddress, contractName] = contract.split(".");
  const res = await fetchCallReadOnlyFunction({
    contractAddress, contractName, functionName: fn,
    functionArgs: args, senderAddress: SENDER, network: "mainnet",
  });
  return cvToJSON(res);
}

const show = async (label, p) => {
  try { console.log(`  ${label}: ${JSON.stringify(await p)}`); }
  catch (e) { console.log(`  ${label}: ERROR ${e.message}`); }
};

const role = (n) => bufferCV(Uint8Array.from([n]));

console.log("=== roles ===");
await show("oracle.has-role(SPMV5H,0x00)", ro(ORACLE, "has-role", [principalCV("SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8"), role(0)]));
await show("oracle.has-role(SPMV5H,0x01)", ro(ORACLE, "has-role", [principalCV("SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8"), role(1)]));
await show("oracle.has-role(shim,0x00)", ro(ORACLE, "has-role", [principalCV(SHIM), role(0)]));
await show("oracle.has-role(shim,0x01)", ro(ORACLE, "has-role", [principalCV(SHIM), role(1)]));

console.log("=== guardians ===");
for (const g of GUARDIANS) {
  await show(`is-guardian(${g})`, ro(SHIM, "is-guardian", [principalCV(g)]));
}

console.log("=== oracle state ===");
await show("is-paused", ro(ORACLE, "is-paused"));
await show("get-trusted-signers", ro(ORACLE, "get-trusted-signers"));

const ids = process.argv.slice(2);
if (ids.length) {
  console.log("=== proposals ===");
  for (const id of ids) {
    await show(`get-proposal(${id})`, ro(SHIM, "get-proposal", [bufferCV(Uint8Array.from(Buffer.from(id.replace(/^0x/, ""), "hex")))]));
  }
}
