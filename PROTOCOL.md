# Private Notes Encryption Protocol (`PROTOCOL.md`)

## Overview
Agents can leave internal private notes on any conversation. Notes are encrypted end-to-end in the browser using Web Crypto (`AES-256-GCM`) before leaving the client; the Switchboard server never receives plaintext or encryption keys.

## Key Ownership & Derivation
- **Workspace Passphrase / Secret**: Held exclusively by authorized agents of that workspace (e.g., distributed out-of-band by a workspace admin) and stored in the browser's `localStorage` (`sb_note_key:<workspace>`).
- **Key Derivation**: The browser derives a 256-bit `AES-GCM` `CryptoKey` using `PBKDF2` (`SHA-256`, `100,000` iterations, salt `switchboard:<workspace>`).
- **Server**: Holds **no** decryption keys.

## What the Server Stores
MongoDB `notes` collection stores only:
- `id`: unique note ID
- `workspace`, `contact`: routing metadata
- `authorSub`: authenticated agent's OIDC `sub`
- `ciphertext`: base64-encoded AES-GCM ciphertext + auth tag
- `iv`: base64-encoded 96-bit random IV generated per note
- `createdAt`: timestamp

## Three Attacks This Scheme Does NOT Stop
1. **Compromised client / XSS**: Because the derived key or passphrase lives in browser memory and `localStorage`, an XSS payload running on the web origin can read the passphrase and exfiltrate plaintext notes.
2. **Revoked agent access**: Removing an agent from a workspace in the IdP revokes API access, but if the former agent retained the shared workspace passphrase and previously cached/captured ciphertexts, they can still decrypt them until the workspace passphrase is rotated.
3. **Metadata & traffic analysis**: The server (and anyone with DB access) can still see *who* (`authorSub`), *when* (`createdAt`), *which* conversation (`workspace`, `contact`), and *approximate note length* (`ciphertext.length`).
