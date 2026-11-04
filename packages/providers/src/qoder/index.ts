import { codecAdapter } from "../codecAdapter.ts";
import { qoderCodec } from "./codec.ts";
import { qoderDescriptor } from "./descriptor.ts";
export const qoderAdapter = codecAdapter("qoder", qoderDescriptor.capabilities, qoderCodec);
