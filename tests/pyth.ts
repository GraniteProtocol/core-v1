import { expect } from "vitest";
import { Cl, ClarityType } from "@stacks/transactions";
import { pyth } from "../contracts/pyth/unit-tests/pyth/helpers";
import { wormhole } from "../contracts/pyth/unit-tests/wormhole/helpers";
import { scalingFactor } from "./utils";

export const pythDecoderPnauContractName = "pyth-pnau-decoder-v3";
export const pythGovernanceContractName = "pyth-governance-v3";
export const pythStorageContractName = "pyth-storage-v4";
export const wormholeCoreContractName = "wormhole-core-v4";
export const guardianSet = wormhole.generateGuardianSetKeychain(19);

export const init_pyth = (sender: any) => {
  wormhole.applyGuardianSetUpdate(
    guardianSet,
    1,
    sender,
    wormholeCoreContractName
  );

  pyth.applyGovernanceDataSourceUpdate(
    pyth.DefaultGovernanceDataSourceUpdate,
    pyth.InitialGovernanceDataSource,
    guardianSet,
    sender,
    pythGovernanceContractName,
    wormholeCoreContractName,
    2n
  );

  pyth.applyPricesDataSourceUpdate(
    pyth.DefaultPricesDataSources,
    pyth.DefaultGovernanceDataSource,
    guardianSet,
    sender,
    pythGovernanceContractName,
    wormholeCoreContractName,
    3n
  );
};

export const get_token_feed = (token: string) => {
  if (token.includes("btc")) return pyth.BtcPriceIdentifier;
  else if (token.includes("eth")) return pyth.StxPriceIdentifier;
  else if (token.includes("usdc")) return pyth.UsdcPriceIdentifier;
  else throw "invalid token feed";
};

export const get_token_min_confidence_ratio = (token: string) => {
  if (token.includes("btc")) return 500; // 5%
  else if (token.includes("eth")) return 500; // 5%;
  else if (token.includes("usdc")) return 100; // 1 %;
  else throw "invalid token feed";
};

export const set_initial_price = async (
  token: string,
  price: bigint,
  deployer: any
): Promise<bigint> => {
  const feed = get_token_feed(token);
  const minConfidenceRatio = get_token_min_confidence_ratio(token);
  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-price-feed-id",
    [
      Cl.contractPrincipal(deployer, token),
      Cl.buffer(feed),
      Cl.uint(minConfidenceRatio),
    ],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);

  return set_price(token, price, deployer);
};

export const set_pyth_time_delta = async (delta: number, deployer: any) => {
  const result = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-time-delta",
    [Cl.uint(delta)],
    deployer
  );
  expect(result.result).toBeOk(Cl.bool(true));
};

export const set_price = async (
  token: string,
  price: bigint,
  deployer: any,
  expo: number = -8,
  prevPublishTime?: bigint
): Promise<bigint> => {
  const feed = get_token_feed(token);
  await sleep(800);
  const publishTime = pyth.timestampNow();
  let actualPricesUpdates = pyth.buildPriceUpdateBatch([
    [
      feed,
      { price: price * scalingFactor, expo, publishTime, prevPublishTime },
    ],
  ]);
  let actualPricesUpdatesVaaPayload =
    pyth.buildAuwvVaaPayload(actualPricesUpdates);
  let payload = pyth.serializeAuwvVaaPayloadToBuffer(
    actualPricesUpdatesVaaPayload
  );
  let vaaBody = wormhole.buildValidVaaBodySpecs({
    payload,
    emitter: pyth.DefaultPricesDataSources[0],
  });
  let vaaHeader = wormhole.buildValidVaaHeader(guardianSet, vaaBody, {
    version: 1,
    guardianSetId: 1,
  });
  let vaa = wormhole.serializeVaaToBuffer(vaaHeader, vaaBody);
  let pnauHeader = pyth.buildPnauHeader();
  let pricesUpdatesToSubmit = [feed];
  let pnau = pyth.serializePnauToBuffer(pnauHeader, {
    vaa,
    pricesUpdates: actualPricesUpdates,
    pricesUpdatesToSubmit,
  });

  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-pyth",
    [Cl.some(Cl.buffer(pnau))],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);

  return publishTime;
};

export const set_price_without_scaling = async (
  token: string,
  price: bigint,
  deployer: any,
  expo: number = -8,
  prevPublishTime?: bigint
): Promise<bigint> => {
  const feed = get_token_feed(token);
  await sleep(800);
  const publishTime = pyth.timestampNow();
  let actualPricesUpdates = pyth.buildPriceUpdateBatch([
    [feed, { price: price, expo, publishTime, prevPublishTime }],
  ]);
  let actualPricesUpdatesVaaPayload =
    pyth.buildAuwvVaaPayload(actualPricesUpdates);
  let payload = pyth.serializeAuwvVaaPayloadToBuffer(
    actualPricesUpdatesVaaPayload
  );
  let vaaBody = wormhole.buildValidVaaBodySpecs({
    payload,
    emitter: pyth.DefaultPricesDataSources[0],
  });
  let vaaHeader = wormhole.buildValidVaaHeader(guardianSet, vaaBody, {
    version: 1,
    guardianSetId: 1,
  });
  let vaa = wormhole.serializeVaaToBuffer(vaaHeader, vaaBody);
  let pnauHeader = pyth.buildPnauHeader();
  let pricesUpdatesToSubmit = [feed];
  let pnau = pyth.serializePnauToBuffer(pnauHeader, {
    vaa,
    pricesUpdates: actualPricesUpdates,
    pricesUpdatesToSubmit,
  });

  const res = simnet.callPublicFn(
    "pyth-adapter-v1",
    "update-pyth",
    [Cl.some(Cl.buffer(pnau))],
    deployer
  );
  expect(res.result).toHaveClarityType(ClarityType.ResponseOk);

  return publishTime;
};

const sleep = async (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};
