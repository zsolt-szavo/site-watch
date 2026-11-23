#!/usr/bin/env python3
"""Generate a VAPID key pair (P-256) as base64url strings.

Public key  -> worker/wrangler.toml VAPID_PUBLIC_KEY (the browser needs it to subscribe)
Private key -> GitHub Actions secret VAPID_PRIVATE_KEY (and checker/.env locally). Never commit it.
"""
import base64
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
key = ec.generate_private_key(ec.SECP256R1())
print("VAPID_PUBLIC_KEY=" + b64(key.public_key().public_bytes(
    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)))
print("VAPID_PRIVATE_KEY=" + b64(key.private_numbers().private_value.to_bytes(32, "big")))
