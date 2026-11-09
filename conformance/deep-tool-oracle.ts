import { collect, type StreamEvent } from "../packages/ir/src/stream";
import { decodeCustomChat, decodeCustomResponses } from "../packages/providers/src/custom/decode";
for (const depth of [200, 512, 40000]) {
  const nested = "[".repeat(depth - 2) + "0" + "]".repeat(depth - 2);
  for (const field of ["usage", "ignored"]) {
    async function* chat() {
      yield {event:"message",data:`{"choices":[{"delta":{"content":"hello"}}],"${field}":{"extra":${nested}}}`};
      yield {event:"message",data:"[DONE]"};
    }
    async function* responses() {
      yield {event:"response.output_text.delta",data:`{"delta":"hello","${field}":{"extra":${nested}}}`};
      yield {event:"response.completed",data:'{"response":{"status":"completed"}}'};
    }
    for (const stream of [decodeCustomChat(chat()),decodeCustomResponses(responses())]) {
      let text="";
      for await(const e of stream) if(e.type==="blockDelta" && e.delta.type==="text") text+=e.delta.text;
      if(text!=="hello") throw Error(`${depth} ${field}`);
    }
    console.log(depth, field, "preserved");
  }
}
for (const depth of [150, 512, 40000]) {
  const raw = "[".repeat(depth) + "0" + "]".repeat(depth);
  for (const protocol of ["chat", "responses"]) {
    async function* messages() {
      if (protocol === "chat") yield {event:"message", data:JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:"c",function:{name:"f",arguments:""}}]}}]})};
      else yield {event:"response.output_item.added",data:JSON.stringify({output_index:0,item:{type:"function_call",call_id:"c",name:"f"}})};
      for (let at=0;at<raw.length;at+=7) {
        const part=raw.slice(at,at+7);
        yield protocol === "chat"
          ? {event:"message",data:JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:part}}]}}]})}
          : {event:"response.function_call_arguments.delta",data:JSON.stringify({output_index:0,delta:part})};
      }
      yield protocol === "chat" ? {event:"message",data:"[DONE]"} : {event:"response.completed",data:'{"response":{"status":"completed"}}'};
    }
    const events: StreamEvent[]=[];
    for await (const e of (protocol === "chat" ? decodeCustomChat(messages()) : decodeCustomResponses(messages()))) events.push(e);
    const result=collect(events);
    const tool=result.content.find(b=>b.type === "toolUse");
    if (!tool || tool.type !== "toolUse" || JSON.stringify(tool.input)!==raw) throw Error(`${depth} ${protocol}`);
    console.log(depth, protocol, "preserved");
  }
}
