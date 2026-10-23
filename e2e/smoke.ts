import { manifestContractNames, startDevnet, stopDevnet } from "./devnet.ts";

const handle = await startDevnet();
try {
  const info = (await (await fetch(`${handle.apiUrl}/v2/info`)).json()) as {
    network_id: number;
    stacks_tip_height: number;
  };
  const names = manifestContractNames();
  console.log(`network_id=${info.network_id} tip=${info.stacks_tip_height} contracts=${names.length}`);
  console.log(`devnet log: ${handle.logPath}`);
} finally {
  await stopDevnet(handle);
}
