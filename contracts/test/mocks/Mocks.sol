// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAgentID} from "../../src/CallLedger.sol";

contract MockAgentID is IAgentID {
    mapping(address => string) public handles;

    function mint(address to, string calldata h) external {
        handles[to] = h;
    }

    function balanceOf(address o) external view returns (uint256) {
        return bytes(handles[o]).length > 0 ? 1 : 0;
    }

    function handleOf(address o) external view returns (string memory) {
        return handles[o];
    }
}

// ----------------------------------------------------------------- honest pools

contract MockV2Pair {
    address public factory;
    address public token0;
    address public token1;

    constructor(address f, address a, address b) {
        factory = f;
        token0 = a;
        token1 = b;
    }
}

contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address pair) {
        pair = address(new MockV2Pair(address(this), a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }

    /// @dev Lets a test register (or unregister) an arbitrary address as the canonical pair.
    function setPair(address a, address b, address pair) external {
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

contract MockV3Pool {
    address public factory;
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address f, address a, address b, uint24 fee_) {
        factory = f;
        token0 = a;
        token1 = b;
        fee = fee_;
    }
}

contract MockV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function createPool(address a, address b, uint24 fee) external returns (address pool) {
        pool = address(new MockV3Pool(address(this), a, b, fee));
        getPool[a][b][fee] = pool;
        getPool[b][a][fee] = pool;
    }
}

// ----------------------------------------------------------------- hostile pools

/// @notice Claims any factory/token pair you like. The factory never maps back to it, so the canonical
///         check must reject it. This is the fake nobody can fake away.
contract LyingPool {
    address public factory;
    address public token0;
    address public token1;
    uint24 public fee;

    constructor(address f, address a, address b, uint24 fee_) {
        factory = f;
        token0 = a;
        token1 = b;
        fee = fee_;
    }
}

/// @notice Reverts on every probe.
contract RevertingPool {
    fallback() external {
        revert("no");
    }
}

/// @notice Returns 8 bytes instead of a 32-byte word.
contract ShortReturnPool {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 8)
        }
    }
}

/// @notice Returns a word with dirty upper bits, i.e. not a valid abi-encoded address.
contract DirtyWordPool {
    fallback() external {
        assembly {
            mstore(0, not(0))
            return(0, 32)
        }
    }
}

/// @notice Answers *honestly*, but every getter costs ~20k gas (as a pool behind a proxy, or one that lazily
///         initialises, would). Registered as canonical via `MockV2Factory.setPair`, it is the case where a
///         gas-starved probe could otherwise be misread as "this pool is not canonical".
contract CostlyPool {
    address private immutable f;
    address private immutable t0;
    address private immutable t1;

    constructor(address f_, address a, address b) {
        f = f_;
        t0 = a;
        t1 = b;
    }

    function _burn() private view {
        uint256 start = gasleft();
        uint256 x = 1;
        while (start - gasleft() < 20_000) {
            x = uint256(keccak256(abi.encode(x)));
        }
    }

    function factory() external view returns (address) {
        _burn();
        return f;
    }

    function token0() external view returns (address) {
        _burn();
        return t0;
    }

    function token1() external view returns (address) {
        _burn();
        return t1;
    }
}

/// @notice Burns every drop of gas it is given, then out-of-gases. Proves the probe gas cap contains it.
contract GasBurnerPool {
    function factory() external view returns (address) {
        uint256 x;
        while (gasleft() > 0) {
            x = uint256(keccak256(abi.encode(x)));
        }
        return address(uint160(x));
    }
}
