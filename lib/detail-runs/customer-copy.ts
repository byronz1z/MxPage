/** Provenance stays in confirmedSupplementalAnswers, not in customer-facing artwork. */
export const confirmedAnswerCopyRules = "用户确认的补充答案是本次设计采用的内容。basis、source、model_estimate、模拟/推测来源仅供内部记录，不是消费者文案，不得在标题、正文、参数表、脚注、水印或图片中标注‘模拟数据’‘非实测’‘仅供设计参考’等来源说明。保留用户选择的具体数值、单位和‘约’，不改称实测、认证或已验证；未确认的候选仍不得使用。";

const provenance = /(?:模拟(?:推测|估算)?(?:数据|参数|数值|方案|规格|答案)|(?:用户)?(?:已)?(?:确认|选用|选择)的模拟(?:推测)?答案|非实测(?:数据|参数)?|未经实测(?:验证)?|仅供(?:设计|设计稿|排版|模拟)(?:参考|使用|展示)|(?:simulated|mock|synthetic)\s+(?:data|values?|specifications?)|not\s+(?:actually\s+)?measured|for\s+design\s+(?:reference|use)\s+only)/gi;

/** Target source annotations only. Never replace numbers, units, “约” or product names such as 模拟器. */
export function customerFacingCopy(text: string): string {
  const clean = (value: string) => value.match(provenance) ? value.replace(provenance, "").replace(/^[\s，,；;：:、]+|[\s，,；;：:、]+$/g, "").trim() : value.trim();
  return text.split(/\r?\n/).map(line => {
    if (!line.match(provenance)) return line;
    const brackets = line.replace(/[（(【\[]([^）)】\]]*)[）)】\]]/g, (whole, inner: string) => {
      if (clean(inner) === inner.trim()) return whole;
      const remaining = clean(inner);
      return remaining ? `（${remaining}）` : "";
    });
    let result = clean(brackets);
    if (result === line.trim()) return line;
    result = result.replace(/(?:以上|上述|本页|本图|所列)?(?:所有|全部)?(?:参数|数据|数值|规格)(?:均)?(?:为|是|采用|属于)[。.!！]?$/, "");
    return /^[。.!！\s]*$/.test(result) ? "" : result;
  }).filter(Boolean).join("\n");
}

export function cleanCustomerDirection<D extends { prompt: string; textBlocks: Array<{ text: string }> }>(direction: D): D {
  return { ...direction, prompt: customerFacingCopy(direction.prompt), textBlocks: direction.textBlocks.map(block => ({ ...block, text: customerFacingCopy(block.text) })).filter(block => block.text.trim()) };
}
