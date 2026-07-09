import { Keypair } from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  console.log('Generating new relayer keypair...');
  const pair = Keypair.random();
  const publicKey = pair.publicKey();
  const secret = pair.secret();

  console.log(`Public Key: ${publicKey}`);
  console.log('Funding account via Friendbot (this can take a few seconds)...');

  try {
    const res = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
    if (res.ok) {
      console.log('✓ Account successfully funded on testnet!');
    } else {
      console.warn('Friendbot returned an error. You may need to fund it manually.');
    }
  } catch (e) {
    console.error('Failed to fund account via Friendbot:', e.message);
  }

  // Update .dev.vars automatically
  const devVarsPath = path.join(__dirname, '..', '.dev.vars');
  if (fs.existsSync(devVarsPath)) {
    let content = fs.readFileSync(devVarsPath, 'utf8');
    content = content.replace(
      'STELLAR_RELAYER_SECRET=',
      `STELLAR_RELAYER_SECRET=${secret}`
    );
    fs.writeFileSync(devVarsPath, content, 'utf8');
    console.log(`✓ Updated frontend/.dev.vars with your relayer secret key!`);
  } else {
    console.log('Please copy this secret key manually to frontend/.dev.vars:');
    console.log(`STELLAR_RELAYER_SECRET=${secret}`);
  }
}

run().catch((e) => console.error(e));
