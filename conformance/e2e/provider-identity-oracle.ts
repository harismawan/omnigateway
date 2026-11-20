import { servesTarget } from "../../packages/store/src/types.ts";

const credential = { provider: "�", id: "replacement", providerData: {} };
for (const provider of ["\ud800", "�"])
  console.log(
    JSON.stringify({ provider, matches: servesTarget({ provider } as never, credential as never) }),
  );
