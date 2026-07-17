export const HUMAN_INPUT_RESPONSE_KEY = "human_input_response";
//定义"用户回答"的数据结构。当 Agent 问用户问题时，用户的回答要打包成这个格式传回给 Agent。
 export interface HumanInputTextResponse {
      version: 1;
      kind: "human_input_response";
      source: string;
      request_id: string;
      response_kind: "text";
      value: string;
  }

  export interface HumanInputOptionResponse {
      version: 1;
      kind: "human_input_response";
      source: string;
      request_id: string;
      response_kind: "option";
      option_id: string;  // string 不是 number
      value: string;
  }