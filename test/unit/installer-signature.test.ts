import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMBIODY_SIGNER, signatureProblem } from "../../src/embiody-browser.js";

/** Reading Get-AuthenticodeSignature's two lines: status, then the signer's subject. */
describe("installer signature", () => {
  it("accepts a valid signature by SELECTIOUS PTY LTD", () => {
    assert.equal(
      signatureProblem("Valid\r\nCN=SELECTIOUS PTY LTD, O=SELECTIOUS PTY LTD, L=Dural, S=New South Wales, C=AU\r\n"),
      null,
    );
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
  });
});
