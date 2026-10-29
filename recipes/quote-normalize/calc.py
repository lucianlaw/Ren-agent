#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
报价表折算 —— 确定性配方
=========================
分工原则：
  模型负责「认」：把混乱的备注（元/箱、一套4个、运费到付、不含税）解析成结构化字段。
  脚本负责「算」：所有换算、摊运费、加税、排序、总成本，一行一行摊开算式。
  模型不许直接给数字。算术出错的代价是签错合同，不能交给概率。

输入：quotes.json（见同目录 SPEC.md）
输出：stdout 的 markdown。不写文件，落盘由调用方决定。

设计上的两个硬规则：
  1. 换算系数缺失（比如「元/箱」但没说一箱几个）→ 不猜，标「待确认」，给出条件值。
  2. 排序排两个：可比单价、满足本周需求的总成本。二者经常不一致，
     因为起订量会让「单价最低」变成「总价最贵」。
"""
import json
import sys


def fmt(x, n=4):
    if x is None:
        return "—"
    s = f"{x:,.{n}f}"
    # 去掉多余的尾零，但保留两位小数
    if "." in s:
        whole, frac = s.split(".")
        frac = frac.rstrip("0")
        if len(frac) < 2:
            frac = (frac + "00")[:2]
        s = whole + "." + frac
    return s


def money(x):
    return "—" if x is None else f"{x:,.2f}"


def normalize(sp, need_qty, tax_rate):
    """返回 (可比单价, 采购量, 总成本, 算式列表, 待确认列表, 警告列表)"""
    steps, unknown, warn = [], [], []

    price = sp.get("price")
    unit = sp.get("price_unit", "")
    factor = sp.get("unit_factor")  # 一个计价单位 = 多少个「个」
    base_unit = sp.get("base_unit", "个")

    # ── 1. 折算到基础单位 ──
    if factor is None:
        unknown.append(f"「{unit}」没有给出换算规格（一{unit.replace('元/','')}等于多少{base_unit}）")
        per_base = None
        steps.append(f"单价 {price} {unit} → 换算规格缺失，无法折算")
    elif factor == 1:
        per_base = price
        steps.append(f"单价 {price} {unit}")
    else:
        per_base = price / factor
        steps.append(f"{price} {unit} ÷ {factor}（一{unit.replace('元/','')}={factor}{base_unit}）= {fmt(per_base)}/{base_unit}")

    # ── 2. 摊运费 ──
    if per_base is not None:
        fpu = sp.get("freight_per_unit") or 0        # 已明确到「每基础单位」的运费
        flat = sp.get("freight_flat") or 0           # 整车 / 整批固定运费
        per_trip = sp.get("qty_per_trip")            # 一车装多少个
        if fpu:
            per_base += fpu
            steps.append(f"+ 运费 {fpu}/{base_unit} = {fmt(per_base)}")
        if flat:
            if per_trip:
                add = flat / per_trip
                per_base += add
                steps.append(f"+ 整车运费 {flat} ÷ {per_trip}{base_unit}/车 = {fmt(add)} → {fmt(per_base)}")
            else:
                unknown.append("有整车运费但没给「一车装多少个」，无法摊到单价")
        if sp.get("freight_note") and not fpu and not flat:
            unknown.append(f"运费未量化：{sp['freight_note']}（当前单价只是下界，加了运费可能反超）")
            warn.append("运费未计入，排名仅供参考")

    # ── 3. 统一税口径（默认换算为含税）──
    if per_base is not None:
        if sp.get("tax_included") is True:
            steps.append("已含税，不再调整")
        elif sp.get("tax_included") is False:
            per_base *= (1 + tax_rate)
            steps.append(f"不含税 × (1+{tax_rate:.0%}) = {fmt(per_base)}（含税）")
        else:
            unknown.append("备注没写含税还是不含税")
            steps.append("税口径未知，按含税记，需确认")

    # ── 4. 采购量与总成本 ──
    moq = sp.get("moq") or 0
    buy_qty = max(need_qty, moq)
    total = None
    if per_base is not None:
        total = per_base * buy_qty
        if moq > need_qty:
            surplus = moq - need_qty
            warn.append(f"起订量 {moq} 高于本周需求 {need_qty}，要多买 {surplus}{base_unit}（够用约 {moq / need_qty:.1f} 周）")
        steps.append(f"采购量 max({need_qty}, 起订{moq}) = {buy_qty} → 总成本 {fmt(per_base)} × {buy_qty} = {money(total)}")

    return per_base, buy_qty, total, steps, unknown, warn


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "quotes.json"
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    need = data["need_qty"]
    base = data.get("base_unit", "个")
    tax = data.get("tax_rate", 0.13)
    rows = []

    for sp in data["suppliers"]:
        pu, qty, total, steps, unknown, warn = normalize(sp, need, tax)
        rows.append({
            "name": sp["name"], "unit_price": pu, "buy_qty": qty, "total": total,
            "lead": sp.get("lead_days"), "moq": sp.get("moq") or 0,
            "steps": steps, "unknown": unknown, "warn": warn,
        })

    # 只要有关键信息缺失，就不进排序 —— 宁可少排一家，也不要排出个错的顺序
    ok = [r for r in rows if not r["unknown"] and r["unit_price"] is not None]
    pend = [r for r in rows if r["unknown"] or r["unit_price"] is None]

    by_price = sorted(ok, key=lambda r: r["unit_price"])
    by_total = sorted(ok, key=lambda r: r["total"])

    out = []
    out.append(f"# 报价折算对比 · {data.get('material', '')}")
    out.append("")
    out.append(f"本周需求 **{need:,} {base}**　税口径统一为含税（{tax:.0%}）　运费已摊入单价")
    out.append("")

    # ── 主表 ──
    out.append("## 一、折算结果")
    out.append("")
    out.append(f"| 排名 | 供应商 | 可比单价(元/{base}) | 采购量 | 总成本 | 交期 | 起订量 | 备注 |")
    out.append("|---|---|---|---|---|---|---|---|")
    for i, r in enumerate(by_total, 1):
        flag = " ⚠" if r["warn"] else ""
        out.append(
            f"| {i} | {r['name']} | {fmt(r['unit_price'])} | {r['buy_qty']:,} | "
            f"{money(r['total'])}{flag} | {r['lead'] or '—'} 天 | {r['moq'] or '—'} |"
            f" {'；'.join(r['warn']) if r['warn'] else '—'} |"
        )
    out.append("")

    # ── 单价 vs 总成本 ──
    price_rank = [r["name"] for r in by_price]
    total_rank = [r["name"] for r in by_total]
    if price_rank != total_rank:
        out.append("> **两个排序不一致 —— 这才是要看的结论。**")
        out.append(f"> 按单价：{' < '.join(price_rank)}")
        out.append(f"> 按总成本：{' < '.join(total_rank)}")
        out.append(">")
        out.append("> 原因在于起订量。单价最低的不一定是本周该下的单。")
        out.append("")

    # ── 无法折算 ──
    if pend:
        out.append("## 二、信息不全，不进排名（不要猜）")
        out.append("")
        for r in pend:
            head = f"**{r['name']}**"
            if r["unit_price"] is not None:
                head += f"　—— 按已知信息折算 {fmt(r['unit_price'])} 元/{base}，但这是不完整值"
            out.append(head)
            for u in r["unknown"]:
                out.append(f"- 缺：{u}")
            for s in r["steps"]:
                out.append(f"- {s}")
            out.append("")
        out.append("→ 处理方式：给这几家回一封补充信息邮件，或在系统里手填规格后重算。"
                   "**不要用它们现在的数字下判断。**")
        out.append("")

    # ── 算式明细 ──
    out.append("## 三、逐家算式（可逐行复核）")
    out.append("")
    for r in by_total:
        out.append(f"**{r['name']}**")
        for s in r["steps"]:
            out.append(f"1. {s}")
        out.append("")

    out.append("---")
    out.append(f"共 {len(rows)} 家，可折算 {len(ok)} 家，待确认 {len(pend)} 家。")
    print("\n".join(out))


if __name__ == "__main__":
    main()
