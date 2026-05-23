/**
 * TypeScript 类型声明：HTML 文件作为字符串导入
 */

declare module '*.html' {
    const content: string;
    export default content;
}

declare module '*.mov' {
    const url: string;
    export default url;
}

declare module '*.png' {
    const url: string;
    export default url;
}
