import { submitApprove, submitDeposit } from '../src/wallet/submit.js'

export function submitCeremonyDeposit({
  contractId,
  amount,
  eligibility,
  kit,
  submit = submitDeposit,
}) {
  return submit({ contractId, amount, eligibility, kit })
}

export function submitCeremonyApprove({
  contractId,
  amount,
  kit,
  submit = submitApprove,
}) {
  return submit({ contractId, amount, kit })
}
