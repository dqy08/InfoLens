/* eslint-disable */

// 此文件由 scripts/generate_ts_schema.py 自动生成，请勿手动修改。



export interface TokenWithOffset {
  offset: [number, number];
  raw: string;
  real_topk?: [number, number] | null;
  pred_topk: [string, number][];
}

export interface AnalyzeResult {
  model?: string | null;
  bpe_strings: TokenWithOffset[];
  error?: string | null;
}

export interface AnalyzeRequest {
  text: string;
}

export interface AnalyzeResponse {
  request: AnalyzeRequest;
  result: AnalyzeResult;
}
