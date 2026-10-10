import {useCallback,useEffect,useState,type CSSProperties} from "react";

/** One resize behaviour for both workspaces; hidden panels keep their saved share. */
export function usePanelLayout(name:string,panels:string[],defaults:Record<string,number>,priority?:string[]) {
  const [node,setNode]=useState<HTMLElement|null>(null);
  const ref=useCallback((element:HTMLElement|null)=>setNode(element),[]);
  const [size,setSize]=useState({width:1360,height:680});
  const [weights,setWeights]=useState<Record<string,number>>(()=>{
    try {return JSON.parse(localStorage.getItem(`mockInterview.panels.${name}`)||"{}");}catch{return {};}
  });
  useEffect(()=>{if(!node)return;
    const measure=()=>setSize(current=>node.clientWidth===current.width&&node.clientHeight===current.height?current:{width:node.clientWidth,height:node.clientHeight});
    measure();const observer=new ResizeObserver(measure);
    observer.observe(node);return ()=>observer.disconnect();
  },[node]);
  useEffect(()=>{localStorage.setItem(`mockInterview.panels.${name}`,JSON.stringify(weights));},[name,weights]);
  const vertical=size.width<=940;
  const order=priority || (name==="assist"?["transcript","answer","setup"]:panels);
  const visible=vertical ? [...panels].sort((a,b)=>order.indexOf(a)-order.indexOf(b)) : panels;
  const values=visible.map(id=>Number.isFinite(weights[id])&&weights[id]>0?weights[id]:defaults[id]||1);
  const total=values.reduce((a,b)=>a+b,0)||1;
  const minimums=visible.map(id=>!vertical&&id==="setup"?220:vertical&&name==="practice"&&id==="dialogue"?340:120);
  const minimumTotal=minimums.reduce((a,b)=>a+b,0);
  const available=Math.max(minimumTotal+40,(vertical?size.height:size.width)-Math.max(0,visible.length-1)*10);
  const pixels=values.map((value,index)=>minimums[index]+(available-minimumTotal)*value/total);
  const tracks=pixels.map(value=>`${value}px`).join(" 10px ");
  const style:CSSProperties={display:"grid",gridTemplateColumns:vertical?"minmax(0,1fr)":tracks,
    gridTemplateRows:vertical?tracks:"minmax(0,1fr)",overflow:vertical?"auto":"hidden",gap:0};
  const panelStyle=(id:string):CSSProperties=>{
    const index=visible.indexOf(id);
    return index<0?{display:"none"}:{minWidth:0,minHeight:0,height:"auto",overflow:id==="setup"?"auto":"hidden",gridColumn:vertical?1:index*2+1,gridRow:vertical?index*2+1:1};
  };
  const resize=(index:number,delta:number)=>{
    const pair=pixels[index]+pixels[index+1];
    const first=Math.max(minimums[index],Math.min(pair-minimums[index+1],pixels[index]+delta));
    const flexible=Math.max(1,available-minimumTotal);
    setWeights(current=>({...current,...Object.fromEntries(visible.map((id,i)=>[id,Math.max(0.0001,((i===index?first:i===index+1?pair-first:pixels[i])-minimums[i])/flexible*total)]))}));
  };
  const dividers=visible.slice(0,-1).map((id,index)=><div key={id} className={`panel-divider ${vertical?"horizontal":"vertical"}`}
    role="separator" tabIndex={0} aria-label={`调整${name==="assist"?"转录与提示":"练习区域"}空间 ${index+1}`} aria-orientation={vertical?"horizontal":"vertical"}
    style={{gridColumn:vertical?1:index*2+2,gridRow:vertical?index*2+2:1}}
    onPointerDown={event=>{
      if(event.button!==0)return;event.preventDefault();event.stopPropagation();
      const node=event.currentTarget;node.setPointerCapture(event.pointerId);
      const origin=vertical?event.clientY:event.clientX;
      const move=(next:PointerEvent)=>resize(index,(vertical?next.clientY:next.clientX)-origin);
      const stop=()=>{node.removeEventListener("pointermove",move);node.removeEventListener("pointerup",stop);node.removeEventListener("pointercancel",stop);node.removeEventListener("lostpointercapture",stop);};
      node.addEventListener("pointermove",move);node.addEventListener("pointerup",stop);node.addEventListener("pointercancel",stop);node.addEventListener("lostpointercapture",stop);
    }} onKeyDown={event=>{
      if(["ArrowLeft","ArrowUp","ArrowRight","ArrowDown"].includes(event.key)){
        event.preventDefault();resize(index,["ArrowLeft","ArrowUp"].includes(event.key)?-20:20);
      }
    }}/>);
  return {ref,style,panelStyle,dividers};
}
