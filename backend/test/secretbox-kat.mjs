// Known-answer test for backend/src/common/secretbox.ts. Run after a build:  node test/secretbox-kat.mjs
// It exists because a global find-and-replace once renamed the salt (forksy -> forky): every value sealed earlier (2FA seeds, push keys)
// became unreadable and sign-in returned 500. If this test fails, someone changed the key derivation: do not "fix" the test, fix the code.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.DATA_ENCRYPTION_KEY = "kat-test-key-do-not-use";
const { seal, unseal } = require("../dist/common/secretbox.js");

const PLAIN = "JBSWY3DPEHPK3PXP";
const SEALED_WITH_CURRENT_SALT = "enc1:AAECAwQFBgcICQoL.vsqKI6EsEFffjQGu8tVdMA.pSRodSO3PwIAjSa3shl1Kg";
const SEALED_WITH_LEGACY_SALT = "enc1:AAECAwQFBgcICQoL.GfSFz5AA5pTu1SPps3yuQQ.BDw5QwozBJQ2wvt1nIuq7w"; // salt shipped by a rebranded build: must stay readable

let failed = 0;
const check = (name, fn) => {
  try { const ok = fn(); console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) failed++; } catch (e) { console.log("FAIL  " + name + "  (" + e.message + ")"); failed++; }
};

check("a value sealed with the current salt can be read", () => unseal(SEALED_WITH_CURRENT_SALT) === PLAIN);
check("a value sealed with the legacy (forky) salt can still be read", () => unseal(SEALED_WITH_LEGACY_SALT) === PLAIN);
check("seal then unseal round trip", () => unseal(seal("round-trip")) === "round-trip");
check("new values are sealed with the CURRENT salt (readable by the known-answer key derivation)", () => {
  const { createHash, createDecipheriv } = require("node:crypto");
  const [iv, tag, enc] = seal(PLAIN).slice(5).split(".").map((p) => Buffer.from(p, "base64url"));
  const d = createDecipheriv("aes-256-gcm", createHash("sha256").update("forksy-secretbox-v1:" + process.env.DATA_ENCRYPTION_KEY).digest(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8") === PLAIN;
});
check("plaintext (legacy rows without the enc1: prefix) is returned unchanged", () => unseal("plain-value") === "plain-value");
check("a value sealed under a different key is rejected", () => {
  process.env.DATA_ENCRYPTION_KEY = "some-other-key";
  try { unseal(SEALED_WITH_CURRENT_SALT); return false; } catch { return true; } finally { process.env.DATA_ENCRYPTION_KEY = "kat-test-key-do-not-use"; }
});

console.log(failed ? failed + " check(s) FAILED" : "all secretbox checks passed");
process.exit(failed ? 1 : 0);
