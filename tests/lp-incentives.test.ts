import { beforeEach, describe, expect, it } from "vitest";
import {
  Cl,
  ClarityType,
  ClarityValue,
  SomeCV,
  UIntCV,
} from "@stacks/transactions";
import {
  deposit,
  set_allowed_contracts,
  initialize_ir,
  mint_token,
  set_asset_cap,
  initialize_staking_reward,
  transfer_token,
} from "./utils";
import { init_pyth, set_initial_price, set_pyth_time_delta } from "./pyth";

const accounts = simnet.getAccounts();
const depositor = accounts.get("wallet_1")!;
const snapshotUploader = accounts.get("wallet_2")!;
const user1 = accounts.get("wallet_3")!;
const user2 = accounts.get("wallet_4")!;
const user3 = accounts.get("wallet_5")!;
const user4 = accounts.get("wallet_6")!;
const user5 = accounts.get("wallet_7")!;
const user6 = accounts.get("wallet_8")!;
const deployer = accounts.get("deployer")!;

function initiate_epoch(details: any, deployer: any) {
  const res = simnet.callPublicFn(
    "lp-incentives-v1",
    "initiate-epoch",
    [Cl.tuple(details)],
    deployer
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

const getUserLpBalance = (user: ClarityValue) => {
  const result = simnet.callReadOnlyFn(
    "state-v1",
    "get-balance",
    [user],
    deployer
  );

  return result.result.value.value;
};

const getUnclaimedUserCount = () => {
  let unclaimedUserCount = simnet.callReadOnlyFn(
    "lp-incentives-v1",
    "get-unclaimed-user-reward-count",
    [],
    user1
  );

  return unclaimedUserCount.result.value.value;
};

const expectUnclaimedUserCount = (amount: bigint) => {
  expect(getUnclaimedUserCount()).toBe(amount);
};

const expectUserLpBalance = (user: ClarityValue, amount: bigint) => {
  expect(getUserLpBalance(user)).toBe(amount);
};

function getTimeForBlock(block: `u${number}`): bigint {
  const clTime: SomeCV<UIntCV> = Cl.deserialize(
    simnet.runSnippet(`(get-stacks-block-info? time ${block})`)
  );
  return clTime.value.value;
}

function initiate_new_snapshot(details: any, uploader: any) {
  const res = simnet.callPublicFn(
    "lp-incentives-v1",
    "initiate-new-snapshot",
    [Cl.tuple(details)],
    uploader
  );

  expect(res.result.type).toBe(ClarityType.ResponseOk);
  return res.result.value.value;
}

type UserAndShares = [string, number];

function createSnapshotPayload(
  userShares: UserAndShares[],
  snapshotId: number
) {
  let arrayResult = [];

  // iterate thru the input and add snapshot_id
  for (let pair of userShares) {
    arrayResult.push(
      Cl.some(
        Cl.tuple({
          user: Cl.principal(pair[0]),
          "lp-shares": Cl.uint(pair[1]),
          "snapshot-id": Cl.uint(snapshotId),
        })
      )
    );
  }

  // fill remaining spaces with none up to 50 elements
  while (arrayResult.length < 50) {
    arrayResult.push(Cl.none());
  }

  return Cl.list(arrayResult);
}

function createNewSnapshot(
  snapshotTime: bigint,
  lpShares: number,
  users: UserAndShares[]
) {
  const snapshotID = initiate_new_snapshot(
    {
      "snapshot-time": Cl.uint(snapshotTime),
      "total-lp-shares": Cl.uint(lpShares),
    },
    snapshotUploader
  );

  let payload = createSnapshotPayload(users, snapshotID);

  let res = simnet.callPublicFn(
    "lp-incentives-v1",
    "upload-snapshot",
    [payload],
    snapshotUploader
  );

  expect(res.result).toBeOk(Cl.bool(true));
  return snapshotID;
}

function expectUserRewards(user: string, rewards: number) {
  const user1Rewards = simnet.callReadOnlyFn(
    "lp-incentives-v1",
    "get-user-rewards",
    [Cl.principal(user)],
    deployer
  );
  expect(user1Rewards.result.value.value.data["earned-rewards"]).toStrictEqual(
    Cl.uint(rewards)
  );
}

function closeEpoch() {
  const res = simnet.callPublicFn(
    "lp-incentives-v1",
    "close-epoch",
    [],
    snapshotUploader
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

function claimRewards(sender: string, onBehalfOf?: string) {
  let arg;
  if (onBehalfOf !== undefined) {
    arg = Cl.some(Cl.principal(onBehalfOf));
  } else {
    arg = Cl.none();
  }
  const res = simnet.callPublicFn(
    "lp-incentives-v1",
    "claim-rewards",
    [arg],
    sender
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

function transferRemainingLpTokens(recepient: string) {
  const res = simnet.callPublicFn(
    "lp-incentives-v1",
    "transfer-remaining-lp-tokens",
    [Cl.principal(recepient)],
    snapshotUploader
  );
  expect(res.result).toBeOk(Cl.bool(true));
}

describe("LP incentives tests", () => {
  beforeEach(async () => {
    init_pyth(deployer);
    set_pyth_time_delta(100000, deployer);
    set_allowed_contracts(deployer);
    set_asset_cap(deployer, 10000000000000n); // 100k USDC
    initialize_ir(deployer);
    initialize_staking_reward(deployer);
    await set_initial_price("mock-usdc", 1n, deployer);
    await set_initial_price("mock-btc", 1n, deployer);
    await set_initial_price("mock-eth", 1n, deployer);
  });

  it("test initiating epoch", async () => {
    let epochDetails = {
      "epoch-start-time": Cl.uint(0),
      "epoch-end-time": Cl.uint(0),
      "epoch-rewards": Cl.uint(0),
      "snapshot-uploader": Cl.principal(snapshotUploader),
    };

    let res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-epoch",
      [Cl.tuple(epochDetails)],
      deployer
    );
    expect(res.result).toBeErr(Cl.uint(100007)); // ERR-INVALID-START-AND-END-TIME

    epochDetails["epoch-end-time"] = Cl.uint(1);
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-epoch",
      [Cl.tuple(epochDetails)],
      deployer
    );
    expect(res.result).toBeErr(Cl.uint(100009)); // ERR-ZERO-REWARDS

    epochDetails["epoch-rewards"] = Cl.uint(100);
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-epoch",
      [Cl.tuple(epochDetails)],
      deployer
    );
    expect(res.result).toBeOk(Cl.bool(true));

    // re-initiating epoch should fail
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-epoch",
      [Cl.tuple(epochDetails)],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100001)); // ERR-EPOCH-INITIATED
  });

  it("test initiating snapshot", async () => {
    let snapshotDetails = {
      "snapshot-time": Cl.uint(100),
      "total-lp-shares": Cl.uint(0),
    };

    let res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-new-snapshot",
      [Cl.tuple(snapshotDetails)],
      deployer
    );
    expect(res.result).toBeErr(Cl.uint(100006)); // ERR-EPOCH-NOT-INITIALIZED

    initiate_epoch(
      {
        "epoch-start-time": Cl.uint(0),
        "epoch-end-time": Cl.uint(100),
        "epoch-rewards": Cl.uint(100),
        "snapshot-uploader": Cl.principal(snapshotUploader),
      },
      deployer
    );

    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-new-snapshot",
      [Cl.tuple(snapshotDetails)],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100008)); // ERR-ZERO-LP-SHARES

    snapshotDetails["total-lp-shares"] = Cl.uint(100);
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-new-snapshot",
      [Cl.tuple(snapshotDetails)],
      snapshotUploader
    );
    expect(res.result).toBeOk(Cl.uint(0));

    // initiating new snapshot with invalid snapshot time
    snapshotDetails["snapshot-time"] = Cl.uint(99);
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-new-snapshot",
      [Cl.tuple(snapshotDetails)],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100016)); // ERR-INVALID-SNAPSHOT-TIME

    // initiating new snapshot without uploading data
    snapshotDetails["snapshot-time"] = Cl.uint(101);
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-new-snapshot",
      [Cl.tuple(snapshotDetails)],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100003)); // ERR-SNAPSHOT-INCOMPLETE

    let payload = createSnapshotPayload(
      [
        [user1, 600],
        [user2, 400],
      ],
      0
    );

    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "upload-snapshot",
      [payload],
      snapshotUploader
    );
    expect(res.result).toBeOk(Cl.bool(true));

    // new snapshot can be initiated
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "initiate-new-snapshot",
      [Cl.tuple(snapshotDetails)],
      snapshotUploader
    );
    expect(res.result).toBeOk(Cl.uint(1));
  });

  it("test close epoch incomplete", async () => {
    let blockTime = getTimeForBlock(`u${simnet.blockHeight - 1}`);
    initiate_epoch(
      {
        "epoch-start-time": Cl.uint(0),
        "epoch-end-time": Cl.uint(blockTime + 20000n),
        "epoch-rewards": Cl.uint(100),
        "snapshot-uploader": Cl.principal(snapshotUploader),
      },
      deployer
    );
    let res = simnet.callPublicFn(
      "lp-incentives-v1",
      "close-epoch",
      [],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100005)); // ERR-EPOCH-INCOMPLETE
  });

  it("test close epoch", async () => {
    let blockTime = getTimeForBlock(`u${simnet.blockHeight - 1}`);
    initiate_epoch(
      {
        "epoch-start-time": Cl.uint(0),
        "epoch-end-time": Cl.uint(blockTime),
        "epoch-rewards": Cl.uint(100),
        "snapshot-uploader": Cl.principal(snapshotUploader),
      },
      deployer
    );
    let res = simnet.callPublicFn(
      "lp-incentives-v1",
      "close-epoch",
      [],
      snapshotUploader
    );
    expect(res.result).toBeOk(Cl.bool(true));

    // cannot close already closed epoch
    res = simnet.callPublicFn(
      "lp-incentives-v1",
      "close-epoch",
      [],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100004)); // ERR-EPOCH-CLOSED
  });

  it("test upload snapshot", async () => {
    let blockTime = getTimeForBlock(`u${simnet.blockHeight - 1}`);
    initiate_epoch(
      {
        "epoch-start-time": Cl.uint(blockTime - 20000n),
        "epoch-end-time": Cl.uint(blockTime + 1000n),
        "epoch-rewards": Cl.uint(100),
        "snapshot-uploader": Cl.principal(snapshotUploader),
      },
      deployer
    );

    createNewSnapshot(blockTime - 1000n, 1000, [
      [user1, 600],
      [user2, 400],
    ]);

    expectUserRewards(user1, 54);
    expectUserRewards(user2, 36);
    // unclaimed user count should be 2
    expectUnclaimedUserCount(2n);

    mint_token("mock-usdc", 100, depositor);
    deposit(100, depositor);
    expectUserLpBalance(Cl.principal(depositor), 100n);

    // transfer lp tokens to lp-incentives contract
    transfer_token(
      "state-v1",
      100,
      depositor,
      Cl.contractPrincipal(deployer, "lp-incentives-v1")
    );

    expectUserLpBalance(Cl.principal(depositor), 0n);
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "lp-incentives-v1"),
      100n
    );

    // close epoch
    simnet.mineEmptyBlocks(10000);
    closeEpoch();

    // claim user 1 rewards themselves
    claimRewards(user1);
    expectUserLpBalance(Cl.principal(user1), 54n);
    expectUserLpBalance(Cl.principal(user2), 0n);
    expectUnclaimedUserCount(1n);

    // claim user2 rewards through user1
    claimRewards(user1, user2);
    expectUserLpBalance(Cl.principal(user1), 54n);
    expectUserLpBalance(Cl.principal(user2), 36n);
    expectUnclaimedUserCount(0n);

    // transfer remaing balance to depositor
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "lp-incentives-v1"),
      10n
    );
    expectUserLpBalance(Cl.principal(depositor), 0n);
    transferRemainingLpTokens(depositor);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "lp-incentives-v1"), 0n);
    expectUserLpBalance(Cl.principal(depositor), 10n);
  });

  it("test close epoch when snapshot is not uploaded", async () => {
    let blockTime = getTimeForBlock(`u${simnet.blockHeight - 1}`);
    initiate_epoch(
      {
        "epoch-start-time": Cl.uint(blockTime - 20000n),
        "epoch-end-time": Cl.uint(blockTime + 1000n),
        "epoch-rewards": Cl.uint(100),
        "snapshot-uploader": Cl.principal(snapshotUploader),
      },
      deployer
    );

    createNewSnapshot(blockTime - 1000n, 1000, [
      [user1, 600],
      [user2, 400],
    ]);

    expectUserRewards(user1, 54);
    expectUserRewards(user2, 36);
    // unclaimed user count should be 2
    expectUnclaimedUserCount(2n);

    initiate_new_snapshot(
      {
        "snapshot-time": Cl.uint(blockTime + 500n),
        "total-lp-shares": Cl.uint(1000),
      },
      snapshotUploader
    );

    // closing epoch should fail
    simnet.mineEmptyBlocks(10000);
    const res = simnet.callPublicFn(
      "lp-incentives-v1",
      "close-epoch",
      [],
      snapshotUploader
    );
    expect(res.result).toBeErr(Cl.uint(100003)); // ERR-SNAPSHOT-INCOMPLETE
  });

  it("test upload multi snapshot", async () => {
    let blockTime = getTimeForBlock(`u${simnet.blockHeight - 1}`);
    initiate_epoch(
      {
        "epoch-start-time": Cl.uint(blockTime - 20000n),
        "epoch-end-time": Cl.uint(blockTime + 20000n),
        "epoch-rewards": Cl.uint(1000),
        "snapshot-uploader": Cl.principal(snapshotUploader),
      },
      deployer
    );

    createNewSnapshot(blockTime - 5000n, 1000, [
      [user1, 600],
      [user2, 400],
    ]);

    expectUserRewards(user1, 225);
    expectUserRewards(user2, 150);

    createNewSnapshot(blockTime + 5000n, 1500, [
      [user1, 600],
      [user2, 400],
      [user3, 250],
      [user4, 250],
    ]);

    expectUserRewards(user1, 325);
    expectUserRewards(user2, 216);
    expectUserRewards(user3, 41);
    expectUserRewards(user4, 41);

    simnet.mineEmptyBlocks(1000);
    createNewSnapshot(blockTime + 10000n, 2500, [
      [user1, 850],
      [user2, 700],
      [user3, 250],
      [user4, 250],
      [user5, 450],
    ]);

    expectUserRewards(user1, 367);
    expectUserRewards(user2, 251);
    expectUserRewards(user3, 53);
    expectUserRewards(user4, 53);
    expectUserRewards(user5, 22);

    simnet.mineEmptyBlocks(1000);
    createNewSnapshot(blockTime + 15000n, 2500, [
      [user1, 850],
      [user2, 700],
      [user3, 250],
      [user4, 250],
      [user5, 450],
    ]);

    expectUserRewards(user1, 409);
    expectUserRewards(user2, 286);
    expectUserRewards(user3, 65);
    expectUserRewards(user4, 65);
    expectUserRewards(user5, 44);

    simnet.mineEmptyBlocks(1000);
    createNewSnapshot(blockTime + 20000n, 3500, [
      [user1, 1000],
      [user2, 800],
      [user3, 350],
      [user4, 350],
      [user5, 500],
      [user6, 500],
    ]);

    expectUserRewards(user1, 444);
    expectUserRewards(user2, 314);
    expectUserRewards(user3, 77);
    expectUserRewards(user4, 77);
    expectUserRewards(user5, 61);
    expectUserRewards(user6, 17);

    // unclaimed user count should be 6
    expectUnclaimedUserCount(6n);

    mint_token("mock-usdc", 1000, depositor);
    deposit(1000, depositor);
    expectUserLpBalance(Cl.principal(depositor), 1000n);

    // transfer lp tokens to lp-incentives contract
    transfer_token(
      "state-v1",
      1000,
      depositor,
      Cl.contractPrincipal(deployer, "lp-incentives-v1")
    );

    expectUserLpBalance(Cl.principal(depositor), 0n);
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "lp-incentives-v1"),
      1000n
    );

    // close epoch
    simnet.mineEmptyBlocks(10000);
    closeEpoch();

    // claim user rewards
    claimRewards(user1);
    claimRewards(user1, user2);
    claimRewards(user3);
    claimRewards(user1, user4);
    claimRewards(user5);
    claimRewards(user6);

    // check rewards
    expectUserLpBalance(Cl.principal(user1), 444n);
    expectUserLpBalance(Cl.principal(user2), 314n);
    expectUserLpBalance(Cl.principal(user3), 77n);
    expectUserLpBalance(Cl.principal(user4), 77n);
    expectUserLpBalance(Cl.principal(user5), 61n);
    expectUserLpBalance(Cl.principal(user6), 17n);
    expectUnclaimedUserCount(0n);

    // transfer remaing balance to depositor
    expectUserLpBalance(
      Cl.contractPrincipal(deployer, "lp-incentives-v1"),
      10n
    );
    expectUserLpBalance(Cl.principal(depositor), 0n);
    transferRemainingLpTokens(depositor);
    expectUserLpBalance(Cl.contractPrincipal(deployer, "lp-incentives-v1"), 0n);
    expectUserLpBalance(Cl.principal(depositor), 10n);
  });
});
