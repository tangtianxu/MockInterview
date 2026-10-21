import {MathText} from './MathText';
import {CodeAnswer} from './ScreenCode';
// Detect output syntax, not algorithm names or question keywords. An unfinished
// fence is already rendered as code while streaming, preserving indentation.
export function AnswerText({text}:{text:string}){
 return /(^|\n) {0,3}(`{3,}|~{3,})/.test(text)?<CodeAnswer text={text}/>:<MathText text={text}/>;
}
