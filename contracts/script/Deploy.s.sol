// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CallLedger, IAgentID} from "../src/CallLedger.sol";

/// Reads the deployer key from ../deployer/key (never printed).
/// Dry run (no tx):   forge script script/Deploy.s.sol --rpc-url $RPC
/// Real deploy:       forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
/// Override the gate / factories for testnet mocks with AGENT_ID, V2_FACTORY, V3_FACTORY env vars.
contract Deploy is Script {
    address constant AGENT_ID_MAINNET = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address constant V2_FACTORY_MAINNET = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73; // PancakeSwap v2
    address constant V3_FACTORY_MAINNET = 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865; // PancakeSwap v3

    function run() external returns (CallLedger ledger) {
        string memory keyPath = vm.envOr("DEPLOYER_KEY_FILE", string("../deployer/key"));
        uint256 pk = vm.parseUint(vm.trim(vm.readFile(keyPath)));
        address gate = vm.envOr("AGENT_ID", AGENT_ID_MAINNET);
        address v2f = vm.envOr("V2_FACTORY", V2_FACTORY_MAINNET);
        address v3f = vm.envOr("V3_FACTORY", V3_FACTORY_MAINNET);
        require(gate.code.length > 0, "gate has no code on this chain");
        require(v2f.code.length > 0, "v2 factory has no code on this chain");
        require(v3f.code.length > 0, "v3 factory has no code on this chain");

        console2.log("deployer  ", vm.addr(pk));
        console2.log("chainId   ", block.chainid);
        console2.log("gate      ", gate);
        console2.log("v2Factory ", v2f);
        console2.log("v3Factory ", v3f);

        vm.startBroadcast(pk);
        ledger = new CallLedger(IAgentID(gate), v2f, v3f);
        vm.stopBroadcast();
        console2.log("CallLedger", address(ledger));
    }
}
