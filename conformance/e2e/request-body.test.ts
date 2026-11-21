import { expect, test } from "bun:test";
import { readRequestBody } from "./request-body.ts";

test("captures UTF-8 byte lengths across chunks and leaves the next request unread", () => {
  const headers = ["Transfer-Encoding: chunked"];
  const wire = "3\r\n雪\r\n2\r\nhi\r\n0\r\nX-Trailer: end\r\n\r\n";
  const end = Buffer.byteLength(wire);
  expect(readRequestBody(Buffer.from(wire).subarray(0, end - 1), 0, headers)).toBeUndefined();
  const read = readRequestBody(Buffer.from(`${wire}NEXT`), 0, headers);
  expect(read?.body.toString()).toBe("雪hi");
  expect(read?.end).toBe(end);
});

test("captures a length-framed body at a byte offset", () => {
  const read = readRequestBody(Buffer.from("start雪AFTER"), 5, ["Content-Length: 3"]);
  expect(read?.body.toString()).toBe("雪");
  expect(read?.end).toBe(8);
});
