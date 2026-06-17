// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgentRegistry} from "./AgentRegistry.sol";

/// @title AgentVaultDepositor
/// @notice Executes scoped vault deposits. Holds NO scope. Authorization is an EIP-712
///         signature by the worker key — NOT msg.sender — so the 1Shot relayer (or any
///         submitter) can broadcast the call gas-abstracted. The signer is recovered and
///         its scope read from AgentRegistry. Jalur B: pulls funds from the scope owner
///         via transferFrom, verifies the balance delta, spends the period cap, deposits
///         ERC-4626 shares straight to the owner.
contract AgentVaultDepositor is ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    AgentRegistry public immutable registry;
    address public immutable guardian;
    mapping(address token => uint256) public reserves;
    mapping(bytes32 => bool) public executed;

    // EIP-712 typed data: the worker key signs this; recovered signer == the agent.
    bytes32 public constant DEPOSIT_TYPEHASH =
        keccak256("AgentDeposit(uint256 amount,uint256 minAmount,uint256 minShares,bytes32 execId)");

    // Distinct typehash so a depositHeld signature can never be replayed as an
    // executeAgentDeposit (and vice-versa). Same fields, different struct name.
    bytes32 public constant HELD_DEPOSIT_TYPEHASH =
        keccak256("AgentHeldDeposit(uint256 amount,uint256 minAmount,uint256 minShares,bytes32 execId)");

    event AgentDepositExecuted(
        address indexed agent, address indexed owner, address indexed vault,
        address token, uint256 assetsIn, uint256 sharesOut, bytes32 execId
    );

    error ScopeInactive();
    error InsufficientReceived(uint256 received, uint256 minAmount);
    error InsufficientShares(uint256 received, uint256 minShares);
    error AlreadyExecuted(bytes32 execId);
    error ZeroShares();
    error NotGuardian();
    error NotStranded();

    constructor(address registry_, address guardian_) EIP712("VibingFarmer", "1") {
        registry = AgentRegistry(registry_);
        guardian = guardian_;
    }

    function pause() external { if (msg.sender != guardian) revert NotGuardian(); _pause(); }
    function unpause() external { if (msg.sender != guardian) revert NotGuardian(); _unpause(); }

    /// @notice EIP-712 digest a worker key must sign. Exposed for tests + the frontend so
    ///         on-chain and off-chain hash the SAME bytes (no divergence).
    function hashDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(DEPOSIT_TYPEHASH, amount, minAmount, minShares, execId)));
    }

    /// @param amount    tokens to pull from the scope owner (declared by the signer)
    /// @param minAmount floor on the *received* delta (fee-on-transfer / slippage guard)
    /// @param minShares floor on the ERC-4626 shares minted to the owner. Hardens against an
    ///                  adversarial/manipulatable vault returning dust shares for a full deposit.
    ///                  Pass 0 to opt out (ZeroShares still rejects a literal-zero mint).
    /// @param execId    deterministic per (owner,vault,planId,step) — replay-safe
    /// @param sig       EIP-712 signature over (amount,minAmount,minShares,execId) by the worker key.
    ///                  The recovered signer IS the agent; msg.sender is irrelevant.
    function executeAgentDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes calldata sig)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        // 0. recover the agent from the signature — this is the authorization, not msg.sender
        address agent = ECDSA.recover(hashDeposit(amount, minAmount, minShares, execId), sig);
        AgentRegistry.AgentScope memory s = registry.scopeOf(agent);

        // 1. scope active
        if (s.owner == address(0) || s.revoked || block.timestamp >= s.expiry) revert ScopeInactive();
        // 2. idempotency — set BEFORE any external call. Also the signature replay guard:
        //    one execId burns one signed authorization.
        if (executed[execId]) revert AlreadyExecuted(execId);
        executed[execId] = true;

        IERC20 token = IERC20(s.token);
        // 3. pull funds (Jalur B). balance-delta below is the real, fee-safe amount.
        uint256 balBefore = token.balanceOf(address(this));
        token.safeTransferFrom(s.owner, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - balBefore;
        if (received < minAmount || received == 0) revert InsufficientReceived(received, minAmount);

        // 4. charge the period cap against the recovered agent (reverts CapExceeded if over)
        registry.rollAndSpend(agent, received);

        // 5. CEI: account reserve before vault interaction
        reserves[s.token] += received;
        token.forceApprove(s.vault, received);
        shares = IERC4626(s.vault).deposit(received, s.owner); // shares → owner directly
        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert InsufficientShares(shares, minShares);
        reserves[s.token] -= received;
        token.forceApprove(s.vault, 0);

        emit AgentDepositExecuted(agent, s.owner, s.vault, s.token, received, shares, execId);
    }

    /// @notice EIP-712 digest for a held-funds deposit. Distinct from hashDeposit so the two
    ///         signatures are non-interchangeable.
    function hashHeldDeposit(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(HELD_DEPOSIT_TYPEHASH, amount, minAmount, minShares, execId)));
    }

    /// @notice Deposit USDC already held by this contract (pushed in by an ERC-7715
    ///         erc20-token-periodic redeem: USDC.transfer → this). Authorization is the
    ///         worker EIP-712 signature + AgentRegistry scope; msg.sender is the relayer.
    ///         Funds come from the contract's OWN unreserved balance — never transferFrom.
    function depositHeld(uint256 amount, uint256 minAmount, uint256 minShares, bytes32 execId, bytes calldata sig)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        address agent = ECDSA.recover(hashHeldDeposit(amount, minAmount, minShares, execId), sig);
        AgentRegistry.AgentScope memory s = registry.scopeOf(agent);
        if (s.owner == address(0) || s.revoked || block.timestamp >= s.expiry) revert ScopeInactive();
        if (executed[execId]) revert AlreadyExecuted(execId);
        executed[execId] = true;

        IERC20 token = IERC20(s.token);
        // Only spend funds NOT already reserved by a concurrent in-flight deposit.
        uint256 available = token.balanceOf(address(this)) - reserves[s.token];
        if (amount == 0 || available < amount || available < minAmount) revert InsufficientReceived(available, minAmount);

        registry.rollAndSpend(agent, amount);

        reserves[s.token] += amount;
        token.forceApprove(s.vault, amount);
        shares = IERC4626(s.vault).deposit(amount, s.owner);
        if (shares == 0) revert ZeroShares();
        if (shares < minShares) revert InsufficientShares(shares, minShares);
        reserves[s.token] -= amount;
        token.forceApprove(s.vault, 0);

        emit AgentDepositExecuted(agent, s.owner, s.vault, s.token, amount, shares, execId);
    }

    /// @notice Guardian escape hatch: sweep funds stranded by a redeem whose depositHeld
    ///         never landed (so transient custody can never become permanent custody).
    ///         Only the unreserved surplus is movable.
    function sweepStranded(address token_, address to) external {
        if (msg.sender != guardian) revert NotGuardian();
        uint256 surplus = IERC20(token_).balanceOf(address(this)) - reserves[token_];
        if (surplus == 0) revert NotStranded();
        IERC20(token_).safeTransfer(to, surplus);
    }
}
