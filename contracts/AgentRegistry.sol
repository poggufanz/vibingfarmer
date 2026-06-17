// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title AgentRegistry
/// @notice The single on-chain source of truth for per-agent deposit bounds.
///         One agent key = one scope, forever. Re-scoping requires a new key.
contract AgentRegistry {
    struct AgentScope {
        address owner;
        address vault;
        address token;
        uint96  capPerPeriod;
        uint32  periodDuration;
        uint96  spentInPeriod;
        uint40  periodStart;
        uint40  expiry;
        bool    revoked;
    }

    mapping(address agent => AgentScope) public scopes;
    mapping(address owner => address[] agents) private _ownerAgents;
    address public depositor;
    address public immutable deployer;
    uint256 public constant MAX_DURATION = 30 days;

    event AgentAuthorized(address indexed owner, address indexed agent, address vault, address token, uint96 capPerPeriod, uint32 periodDuration, uint40 expiry);
    event AgentRevoked(address indexed owner, address indexed agent);
    event DepositorSet(address indexed depositor);

    error ScopeExists();
    error InvalidScope();
    error NotOwner();
    error NotDeployer();
    error NotDepositor();
    error ScopeInactive();
    error DepositorAlreadySet();
    error CapExceeded(uint256 attempted, uint256 remaining);

    constructor() { deployer = msg.sender; }

    /// @notice Set the depositor once. Only the deployer; immutable afterwards.
    function setDepositor(address dep) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (depositor != address(0)) revert DepositorAlreadySet();
        if (dep == address(0)) revert InvalidScope();
        depositor = dep;
        emit DepositorSet(dep);
    }

    function authorizeSessionKey(
        address agent,
        address vault,
        address token,
        uint96 capPerPeriod,
        uint32 periodDuration,
        uint40 expiry
    ) external {
        if (scopes[agent].owner != address(0)) revert ScopeExists();
        if (agent == address(0) || vault == address(0) || token == address(0)) revert InvalidScope();
        if (capPerPeriod == 0 || periodDuration == 0) revert InvalidScope();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_DURATION) revert InvalidScope();
        if (IERC4626(vault).asset() != token) revert InvalidScope();

        scopes[agent] = AgentScope({
            owner: msg.sender,
            vault: vault,
            token: token,
            capPerPeriod: capPerPeriod,
            periodDuration: periodDuration,
            spentInPeriod: 0,
            periodStart: uint40(block.timestamp),
            expiry: expiry,
            revoked: false
        });
        _ownerAgents[msg.sender].push(agent);
        emit AgentAuthorized(msg.sender, agent, vault, token, capPerPeriod, periodDuration, expiry);
    }

    function revokeAgent(address agent) external {
        if (scopes[agent].owner != msg.sender) revert NotOwner();
        scopes[agent].revoked = true;
        _removeOwnerAgent(msg.sender, agent);
        emit AgentRevoked(msg.sender, agent);
    }

    function revokeMany(address[] calldata agents) external {
        for (uint256 i; i < agents.length; ++i) {
            if (scopes[agents[i]].owner != msg.sender) revert NotOwner();
            scopes[agents[i]].revoked = true;
            _removeOwnerAgent(msg.sender, agents[i]);
            emit AgentRevoked(msg.sender, agents[i]);
        }
    }

    /// @dev Swap-and-pop the agent out of the owner's index list so it cannot grow
    ///      unbounded across authorize/revoke cycles. scopes[agent] is retained
    ///      (revoked) for the on-chain audit trail; only the view index shrinks.
    function _removeOwnerAgent(address owner, address agent) private {
        address[] storage list = _ownerAgents[owner];
        uint256 len = list.length;
        for (uint256 i; i < len; ++i) {
            if (list[i] == agent) {
                list[i] = list[len - 1];
                list.pop();
                return;
            }
        }
    }

    function isActive(address agent) external view returns (bool) {
        AgentScope storage s = scopes[agent];
        return s.owner != address(0) && !s.revoked && block.timestamp < s.expiry;
    }

    function scopeOf(address agent) external view returns (AgentScope memory) {
        return scopes[agent];
    }

    function scopesOfOwner(address owner) external view returns (address[] memory) {
        return _ownerAgents[owner];
    }

    /// @notice Roll the fixed window if elapsed, then charge `amount` against the cap.
    ///         Only callable by the wired depositor. Reverts CapExceeded if over.
    function rollAndSpend(address agent, uint256 amount) external {
        if (msg.sender != depositor) revert NotDepositor();
        AgentScope storage s = scopes[agent];
        // Defense-in-depth: never divide by a zero periodDuration (unscoped agent) and
        // never charge an inactive scope, even if a caller forgets the pre-check.
        if (s.owner == address(0) || s.revoked || block.timestamp >= s.expiry) revert ScopeInactive();
        uint256 elapsed = block.timestamp - s.periodStart;
        if (elapsed >= s.periodDuration) {
            s.periodStart += uint40((elapsed / s.periodDuration) * s.periodDuration);
            s.spentInPeriod = 0;
        }
        uint256 remaining = uint256(s.capPerPeriod) - s.spentInPeriod;
        if (amount > remaining) revert CapExceeded(amount, remaining);
        s.spentInPeriod += uint96(amount);
    }
}
