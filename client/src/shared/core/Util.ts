import * as d3 from "d3";
import "./d3-polyfill";
import { TokenWithOffset } from "../../shared/api/generatedSchemas";

/**
 * Created by hen on 5/15/17.
 */
let the_unique_id_counter = 0;

export class Util {
    static simpleUId({prefix = ''}): string {
        the_unique_id_counter += 1;

        return prefix + the_unique_id_counter;
    }
}

export type D3Sel = d3.Selection<any, any, any, any>

export function argsort(array, sortFct):number[] {
    return array
        .map((d, i) => [d, i])
        .sort((a,b) => sortFct(a[0], b[0]))
        .map(d => d[1]);
}

export function range(end){
    return [...Array(end).keys()]
}

/** 判断是否为有限数字（排除 NaN、Infinity、非 number 类型） */
export function isFiniteNumber(x: unknown): x is number {
    return typeof x === 'number' && Number.isFinite(x);
}

export function obj_to_arr(obj:object){
    const sortedKeys = Object.keys(obj).sort();
    const res=[];
    sortedKeys.forEach(k => {res.push(k); res.push(obj[k])})
    return res;
}

export function arr_to_obj(arr:any){
    const res={};
    const max_l = Math.floor(arr.length/2);
    for (let i = 0; i<max_l; i++){
        res[arr[2*i]] = arr[2*i+1];
    }
    return res;
}

export function splitString(string, splitters) {
    var list = [string];
    for(var i=0, len=splitters.length; i<len; i++) {
        traverseList(list, splitters[i], 0);
    }
    return flatten(list);
}

export function traverseList(list, splitter, index) {
    if(list[index]) {
        if((list.constructor !== String) && (list[index].constructor === String)) {
            const splitted = list[index].split(splitter);
            if (splitted.length > 1) {
                list[index] = splitted;
            }
        }
        (list[index].constructor === Array) ? traverseList(list[index], splitter, 0) : null;
        (list.constructor === Array) ? traverseList(list, splitter, index+1) : null;
    }
}

export function flatten(arr) {
    return arr.reduce(function(acc, val) {
        return acc.concat(val.constructor === Array ? flatten(val) : val);
    },[]);
}


// Kudos: https://stackoverflow.com/questions/9401312/how-to-replace-curly-quotation-marks-in-a-string-using-javascript#answer-9401374
// Note: Removed em dash (\u2014) replacement to preserve Chinese em dash "——"
export const cleanSpecials = input => input
    // .replace(/[‘’]/g, "'") // 注释掉替换卷单引号的逻辑
    // .replace(/[“”]/g, '"') // 注释掉替换卷双引号的逻辑
    // .replace(/[–]/g, "-");  // 注释掉替换en dash的逻辑，em dash (—) 已在上一个版本中移除替换

/**
 * Calculate surprisal (information content) from probability
 * @param probability - The probability value (0 < p <= 1)
 * @returns Surprisal in bits (using base-2 logarithm)
 */
export function calculateSurprisal(probability: number): number {
    return -Math.log2(Math.max(probability, Number.EPSILON));
}

/**
 * 计算token的字符数（中文按字，英文按字母）
 * 使用Array.from正确处理Unicode字符（包括emoji）
 * @param tokenText token文本
 * @returns 字符数
 */
export function countTokenCharacters(tokenText: string): number {
    // 使用Array.from正确处理Unicode字符（包括中文、emoji等）
    return Array.from(tokenText).length;
}

// 复用 TextEncoder 实例，避免每次调用都创建新实例
const textEncoder = new TextEncoder();

/**
 * 获取字符串的UTF-8编码字节长度
 * @param value 要计算字节长度的字符串
 * @returns UTF-8编码的字节数
 */
export const getByteLength = (value: string): number => {
    return textEncoder.encode(value).length;
};

/**
 * 计算单位字节的surprisal值
 * @param surprisal token的总surprisal值
 * @param tokenText token文本
 * @returns 单位字节的surprisal值（bits/Byte）
 */
function calculateSurprisalPerByte(surprisal: number, tokenText: string): number {
    // 按UTF-8编码字节数计算
    const byteCount = getByteLength(tokenText);
    return byteCount > 0 ? surprisal / byteCount : 0;
}

/**
 * 计算信息密度（统一接口，方便将来扩展）
 * @param token token对象，包含real_topk和raw字段
 * @returns 信息密度值（bits/Byte）
 */
export function calculateSurprisalDensity(token: TokenWithOffset): number {
    const [rank, prob] = token.real_topk;
    const surprisal = calculateSurprisal(prob);
    const tokenText = token.raw;
    return calculateSurprisalPerByte(surprisal, tokenText);
}

/**
 * 为文本创建字符索引到字节索引的映射表
 * @param text 原始文本
 * @returns 数组，charToByteIndex[charIndex] = byteIndex
 */
export function buildCharToByteIndexMap(text: string): number[] {
    const map: number[] = [];
    let byteOffset = 0;
    
    for (let charIndex = 0; charIndex < text.length; charIndex++) {
        map[charIndex] = byteOffset;
        // 获取当前字符的UTF-8字节长度
        const char = text[charIndex];
        byteOffset += getByteLength(char);
    }
    
    // 添加末尾位置（文本总字节长度）
    map[text.length] = byteOffset;
    
    return map;
}
