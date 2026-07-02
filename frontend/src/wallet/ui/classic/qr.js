import QRCode from 'qrcode'

export function addressQrDataUrl(address) {
  return QRCode.toDataURL(address, { margin: 1, width: 180 })
}
