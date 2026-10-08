import { useLayoutEffect, useRef } from "react";
import renderMathInElement from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";
import "./mathText.css";

// React owns the container; KaTeX owns its contents. Unclosed or invalid math
// stays readable as source text, including during incremental generation.
export function MathText({text}: {text:string}) {
  const container=useRef<HTMLSpanElement>(null);
  useLayoutEffect(()=>{
    const element=container.current;
    if(!element)return;
    element.textContent=text;
    renderMathInElement(element,{
      delimiters:[
        {left:"$$",right:"$$",display:true},
        {left:"\\[",right:"\\]",display:true},
        {left:"\\(",right:"\\)",display:false},
      ],
      throwOnError:true,trust:false,strict:"ignore",maxSize:10,maxExpand:1000,
      errorCallback:()=>{},
    });
  },[text]);
  return <span className="math-text" ref={container}/>;
}
