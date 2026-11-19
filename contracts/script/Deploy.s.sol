// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CallLedger, IAgentID} from "../src/CallLedger.sol";

/// Reads the deployer key from ../deployer/key (never printed).
/// Dry run (no tx):   forge script script/Deploy.s.sol --rpc-url $RPC
/// Real deploy:       forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
/// Override gate for testnet mocks with AGENT_ID=0x... env var.
contract Deploy is Script {
    address constant AGENT_ID_MAINNET = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    function run() external returns (CallLedger ledger) {
        string memory keyPath = vm.envOr("DEPLOYER_KEY_FILE", string("../deployer/key"));
        uint256 pk = vm.parseUint(vm.trim(vm.readFile(keyPath)));
        address gate = vm.envOr("AGENT_ID", AGENT_ID_MAINNET);
        require(gate.code.length > 0, "gate has no code on this chain");

        console2.log("deployer", vm.addr(pk));
        console2.log("chainId ", block.chainid);
        console2.log("gate    ", gate);

        vm.startBroadcast(pk);
        ledger = new CallLedger(IAgentID(gate));
        vm.stopBroadcast();
        console2.log("CallLedger", address(ledger));
    }
}
