import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EMBIODY_SIGNER, signatureProblem, verifyInstallerSignature } from "../../src/embiody-browser.js";

/** Reading Get-AuthenticodeSignature's two lines: status, then the signer's subject. */
describe("installer signature", () => {
  it("accepts a valid signature by SELECTIOUS PTY LTD, wherever CN sits in the subject", () => {
    assert.equal(
      signatureProblem("Valid\r\nCN=SELECTIOUS PTY LTD, O=SELECTIOUS PTY LTD, L=Dural, S=New South Wales, C=AU\r\n"),
      null,
    );
    assert.equal(signatureProblem(`Valid\nO=X, CN=${EMBIODY_SIGNER}, C=AU\n`), null);
  });

  it("refuses an unsigned or broken file", () => {
    assert.match(signatureProblem("NotSigned\r\n\r\n")!, /not valid \(NotSigned\)/);
    assert.match(signatureProblem("HashMismatch\r\nCN=SELECTIOUS PTY LTD\r\n")!, /not valid \(HashMismatch\)/);
    assert.match(signatureProblem("")!, /no status/);
  });

  it("refuses a valid signature by anyone else, even one naming us in another field", () => {
    assert.match(
      signatureProblem("Valid\r\nCN=OpenJS Foundation, O=OpenJS Foundation, C=US\r\n")!,
      new RegExp(`signed by OpenJS Foundation, not ${EMBIODY_SIGNER}`),
    );
    assert.match(signatureProblem(`Valid\r\nCN=Someone, O=${EMBIODY_SIGNER}\r\n`)!, /signed by Someone/);
    assert.match(signatureProblem(`Valid\r\nCN=${EMBIODY_SIGNER} X\r\n`)!, /signed by/);
    assert.match(signatureProblem("Valid\r\nO=Nobody\r\n")!, /unnamed signer/);
  });
});

/** The real PowerShell call, on files whose signatures are known. */
describe("installer signature, checked by Windows", { skip: process.platform !== "win32" && "Windows only" }, () => {
  it("refuses node.exe: validly signed, but by OpenJS Foundation", async () => {
    await assert.rejects(verifyInstallerSignature(process.execPath), /not run: it is signed by OpenJS Foundation/);
  });

  it("refuses an unsigned file whose path has spaces, quotes and $", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bd sig $x '"));
    try {
      const file = path.join(dir, "Embiody Setup $(whoami) 'x'.exe");
      await writeFile(file, "not a program");
      await assert.rejects(verifyInstallerSignature(file), /not run: its digital signature is not valid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file that is not there", async () => {
    await assert.rejects(verifyInstallerSignature(path.join(tmpdir(), "bd-no-such-installer.exe")), /not run/);
  });

  it("refuses when SystemRoot is unset, rather than running whatever powershell is on PATH", async () => {
    const saved = process.env.SystemRoot;
    delete process.env.SystemRoot;
    try {
      await assert.rejects(verifyInstallerSignature(process.execPath), /not run: SystemRoot is not set/);
    } finally {
      process.env.SystemRoot = saved;
    }
  });
});
