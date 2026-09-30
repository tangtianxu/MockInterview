//! Conservative answer routing; this does not decide whether to trigger Assist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionType { Technical, Personal, Mixed }

impl QuestionType {
    pub fn as_str(self)->&'static str {match self {Self::Technical=>"technical",Self::Personal=>"personal",Self::Mixed=>"mixed"}}
}

pub fn classify(text:&str)->QuestionType {
    let q=text.to_lowercase();
    let personal=["你的项目","你做的","你做过","你参与","你负责","你在","你的经历","你的实习","实习中","简历","项目中","项目里","你们项目","你遇到","你如何处理","your project","your experience","your resume","a project you","project you","you led","you built","you worked","you fixed","you handled","a time when","did you","have you implemented","你如何实现","怎么实现的"];
    let technical=["什么是","原理","机制","优缺点","区别","对比","适用边界","如何工作","怎么理解","定义","why does","what is","how does","trade-off","tradeoff","compare","difference","概念"];
    let has_personal=personal.iter().any(|v|q.contains(v));
    let has_technical=technical.iter().any(|v|q.contains(v)) ||
        (["并","结合","同时"," and "].iter().any(|v|q.contains(v))
         && ["lora","rag","vla","redcap","5g","tsn","向量检索","边云推理","低秩"].iter().any(|v|q.contains(v))
         && ["解释","介绍","说明","讲讲","explain","describe"].iter().any(|v|q.contains(v)));
    if has_personal && has_technical {QuestionType::Mixed}
    else if has_personal {QuestionType::Personal}
    else {QuestionType::Technical}
}

/// Mixed questions often end with a generic personal clause ("what did you do in
/// the project?"). Search the personal library by the named technical subject,
/// rather than diluting it with generic interview words.
pub fn personal_retrieval_query(question:&str, kind:QuestionType)->String {
    if kind!=QuestionType::Mixed {return question.to_string();}
    for separator in ["，并", ", and ", " and ", "并", "然后", "同时"] {
        if let Some((subject,_))=question.split_once(separator) {
            if subject.chars().count()>=5 {
                let named_subject=subject.split(|c:char|!c.is_ascii_alphanumeric())
                    .filter(|word|word.len()>=3 && !matches!(word.to_ascii_lowercase().as_str(),"what"|"explain"|"describe"|"compare"|"with"|"your"))
                    .max_by_key(|word|word.len());
                return named_subject.unwrap_or(subject).to_string();
            }
        }
    }
    question.to_string()
}

pub fn technical_part(question:&str)->String {
    for separator in ["？", "?", "，并", ", and ", " and ", "并", "然后", "同时"] {
        if let Some((left,right))=question.split_once(separator) {
            let part=if classify(left)==QuestionType::Personal && classify(right)==QuestionType::Technical {right}else{left};
            if part.chars().count()>=4 {return part.trim().to_string();}
        }
    }
    question.to_string()
}

/// A compact display cue from a longer verbatim excerpt. The complete source
/// wording remains available in Details and the answer event.
pub fn evidence_headline(evidence:&str,chinese:bool)->String {
    let budget=if chinese {42}else{94};
    let first=evidence.split(['，','；','。',';']).next().unwrap_or(evidence).trim();
    let candidate=if first.chars().count()>=12 {first}else{evidence};
    if candidate.chars().count()<=budget {candidate.to_string()}
    else {format!("{}…",candidate.chars().take(budget.saturating_sub(1)).collect::<String>())}
}

/// Render a checked card without asking the generative model to restate its facts.
pub fn render_verified_card(card:&crate::interview_library::QaCard,kind:QuestionType,chinese:bool,personal_evidence:Option<&str>)->String {
    let points=card.short_points.lines().map(|line|line.trim().trim_start_matches(['-','*',' ']))
        .filter(|line|!line.is_empty()).collect::<Vec<_>>();
    if kind==QuestionType::Mixed {
        let first=points.first().copied().unwrap_or("").trim_start_matches("定义：").trim_start_matches("Definition: ");
        let rest=points.iter().skip(1).copied().collect::<Vec<_>>().join("\n");
        let personal=personal_evidence.unwrap_or(if chinese {"未找到支持个人项目部分的本地资料。"}else{"No supporting personal project material was retrieved."});
        let personal_short=evidence_headline(personal,chinese);
        if chinese {
            format!("- 技术解释：{first}\n- 项目证据：{personal_short}\n\n详情：\n{rest}\n{}\n个人资料原文：{personal}\n易错点：{}\n来源：{}",card.explanation,card.pitfalls,card.source)
        }else{
            format!("- Technical: {first}\n- Project evidence: {personal_short}\n\nDetails:\n{rest}\n{}\nPersonal source excerpt: {personal}\nPitfalls: {}\nSource: {}",card.explanation,card.pitfalls,card.source)
        }
    }else{
        let summary=points.iter().map(|line|format!("- {line}")).collect::<Vec<_>>().join("\n");
        if chinese {format!("{summary}\n\n详情：{}\n易错点：{}\n来源：{}",card.explanation,card.pitfalls,card.source)}
        else {format!("{summary}\n\nDetails: {}\nPitfalls: {}\nSource: {}",card.explanation,card.pitfalls,card.source)}
    }
}

pub fn instructions(kind:QuestionType,chinese:bool)->&'static str {
    match (kind,chinese) {
        (QuestionType::Technical,true)=>"这是纯技术题。开头恰好三条单行要点，依次以“定义：”“机制/优劣：”“边界：”起头，每条尽量不超过40字；补充内容放在空行后的“详情：”，最多两句。可使用可靠通用知识；无本地资料时不要说缺少个人依据。如果提供技术参考，只重述其明确支持的机制和限制，不新增适用任务类别、实验结论、具体失败模式、推测性因果链、标准数字或性能指标。不能从参考推出的追问应说需在目标任务上验证。边界写条件或取舍，不要武断说某技术不适用于某类任务。不要加入无关简历内容。",
        (QuestionType::Technical,false)=>"This is a technical question. Start with exactly three short single-line bullets: Definition, Mechanism/tradeoff, Boundary. Put at most two sentences after a blank line marked Details. General knowledge is allowed. When technical references are supplied, stay within their supported mechanisms and limitations; do not invent task categories, experimental findings, failure modes, numerical claims, or causal chains. Say when a follow-up needs testing on the target task. Do not include unrelated resume details.",
        (QuestionType::Personal,true)=>"这是个人项目或经历题。开头最多三条单行要点，每条尽量不超过40字；补充内容放在空行后的“详情：”。只使用下方个人资料明确支持的事实；无证据的细节说明资料未覆盖。面试官问题、技术常识和主题标签不能作为个人经历证据。",
        (QuestionType::Personal,false)=>"This asks about the candidate's project or experience. Start with up to three short single-line bullets; put extra explanation after a blank line marked Details. State only facts supported by personal materials. The question and topic tags are not evidence. Say when a detail is unsupported.",
        (QuestionType::Mixed,true)=>"这是混合题。你只生成技术解释，不要回答、推测或复述个人项目部分；程序会单独附上个人资料原文。开头以“技术解释：”输出一条不超过50字的单行要点；补充技术内容放在空行后的“详情：”，最多两句。如果提供技术参考，只重述其明确支持的机制和限制，不新增适用任务类别、实验结论、具体失败模式、标准数字或性能指标。边界写条件或取舍，不混淆不同性能指标。",
        (QuestionType::Mixed,false)=>"This is a mixed question. Generate only the technical explanation. Do not answer, infer, or repeat the personal-project part; the app appends verbatim personal source evidence separately. Start with one short Technical explanation line and put at most two sentences after a blank line marked Details. When technical references are supplied, stay within their supported mechanisms and limitations. Avoid unsupported task categories, experiments, numbers, guarantees, and invented sources.",
    }
}

#[cfg(test)] mod tests {use super::*;#[test] fn routes_three_types(){assert_eq!(classify("什么是 LoRA，它的适用边界是什么？"),QuestionType::Technical);assert_eq!(classify("你在实习中负责什么？"),QuestionType::Personal);assert_eq!(classify("请介绍一下你的项目"),QuestionType::Personal);assert_eq!(classify("Tell me about a project you led"),QuestionType::Personal);assert_eq!(classify("解释 LoRA 原理，并说说你在项目中怎么用的"),QuestionType::Mixed);assert_eq!(classify("介绍 5G RedCap，并讲讲你在项目中的应用"),QuestionType::Mixed);}
#[test] fn mixed_personal_lookup_uses_named_subject(){assert_eq!(personal_retrieval_query("解释 RedCap 的能力取舍，并说明你在项目中的验证工作。",QuestionType::Mixed),"RedCap");assert_eq!(technical_part("什么是 5G RedCap？你在项目中做了什么？"),"什么是 5G RedCap");}}
