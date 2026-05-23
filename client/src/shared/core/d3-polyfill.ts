import * as d3 from 'd3';

declare module 'd3-selection' {
    export interface Selection<GElement extends d3.BaseType, Datum, PElement extends d3.BaseType, PDatum> {
        attrs(attributes: { [key: string]: any }): this;
        styles(styles: { [key: string]: any }): this;
    }
    export interface Transition<GElement extends d3.BaseType, Datum, PElement extends d3.BaseType, PDatum> {
        attrs(attributes: { [key: string]: any }): this;
        styles(styles: { [key: string]: any }): this;
    }
}

(d3.selection.prototype as any).attrs = function(attrs: any) {
    for (const name in attrs) {
        this.attr(name, attrs[name]);
    }
    return this;
};

(d3.selection.prototype as any).styles = function(styles: any) {
    for (const name in styles) {
        this.style(name, styles[name]);
    }
    return this;
};

// Transition support might be needed too
if ((d3 as any).transition) {
    ((d3 as any).transition.prototype as any).attrs = function(attrs: any) {
        for (const name in attrs) {
            this.attr(name, attrs[name]);
        }
        return this;
    };

    ((d3 as any).transition.prototype as any).styles = function(styles: any) {
        for (const name in styles) {
            this.style(name, styles[name]);
        }
        return this;
    };
}

