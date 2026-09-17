# Core dependency graph

Snapshot reconciled on 2026-09-16. Historical reviewed application `4aa1cc64b3ecab669c76ffa672832d4c5638ac68`. Native GitHub blockers determine current readiness. There are 225 core edges and one external planning edge, A0 blocked by completed #13.

## Remaining work

Arrows point from prerequisite to consumer. Historical closed prerequisites are listed in the complete table below.

```mermaid
flowchart TD
  I6["I6 #58"]
  J3["J3 #62"]
  J4["J4 #63"]
  J5["J5 #64"]
  B5["B5 #134"]
  D7["D7 #135"]
  I9["I9 #136"]
  I10["I10 #137"]
  I11["I11 #138"]
  J6["J6 #139"]
  C6["C6 #197"]
  R25["R25 #230"]
  R28["R28 #236"]
  R29["R29 #237"]
  R30["R30 #242"]
  R31["R31 #244"]
  I10 --> I6
  J6 --> J3
  J6 --> J4
  I6 --> J5
  J3 --> J5
  J4 --> J5
  I9 --> J5
  I11 --> J5
  R31 --> B5
  R25 --> D7
  R30 --> D7
  D7 --> I9
  D7 --> I10
  R28 --> I11
  R29 --> I11
  D7 --> J6
  B5 --> J6
  J5 --> C6
  R28 --> R29
```

## Scheduling and ownership

The repaired clarification lane is ordered by ownership: R2 follows the closed R1 because both own clarification persistence; R3 follows R2 because both change deletion execution; R5 consumed R1's resolution evidence for in-app links and export targets and closed with its live-leg record (the 121-newer-messages direct open, the legacy redirect and the refusal screens on the dev/i4 lease). R3 owns push/service-worker routes.

R8 supplies Workers hosting and R9 verifies the actual Convex target. R11 precedes E8 to serialize dependency changes. I8 resumes after R9/E8; R10 also gates J6. M2 records the integrated map update; recheck live state before dispatch. R6 is historical release tooling, not proof of the new candidate. B5, D7 and I11 can run independently after I8, with separate fixtures and resource reservations. I9 waits for R5 because the export format gains source targets. I10 waits for R3 so backups contain the repaired lifecycle state. I6 consumes complete backup manifests, not business export archives, and therefore does not wait for I9.

J6 waits for B5 so its joined proof uses ordinary real authentication. J3 and J4 consume its recorded candidate. Start J4 promptly once ready; its Google observation needs more than seven real elapsed days. Parallel lanes still serialize schema/configuration writers and reserve distinct tenants, accounts, bucket namespaces and notification destinations. Qualification evidence is rechecked after changes to its relevant code, provider, configuration or fixture.

## Complete direct dependency inventory

| Key | Cached state | Direct native blockers | Role |
| --- | --- | --- | --- |
| [A0 #65](https://github.com/wojtekpiskorz/kiero/issues/65) | CLOSED | None; [planning #13](https://github.com/wojtekpiskorz/kiero/issues/13) | Historical implementation |
| [A1 #16](https://github.com/wojtekpiskorz/kiero/issues/16) | CLOSED | [A0 #65](https://github.com/wojtekpiskorz/kiero/issues/65) | Historical implementation |
| [A2 #17](https://github.com/wojtekpiskorz/kiero/issues/17) | CLOSED | [A1 #16](https://github.com/wojtekpiskorz/kiero/issues/16) | Historical implementation |
| [A3 #18](https://github.com/wojtekpiskorz/kiero/issues/18) | CLOSED | [A2 #17](https://github.com/wojtekpiskorz/kiero/issues/17), [I1 #53](https://github.com/wojtekpiskorz/kiero/issues/53) | Historical implementation |
| [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19) | CLOSED | [A3 #18](https://github.com/wojtekpiskorz/kiero/issues/18) | Historical implementation |
| [B1 #20](https://github.com/wojtekpiskorz/kiero/issues/20) | CLOSED | [A3 #18](https://github.com/wojtekpiskorz/kiero/issues/18) | Historical implementation |
| [B2 #21](https://github.com/wojtekpiskorz/kiero/issues/21) | CLOSED | [B1 #20](https://github.com/wojtekpiskorz/kiero/issues/20) | Historical implementation |
| [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22) | CLOSED | [B1 #20](https://github.com/wojtekpiskorz/kiero/issues/20) | Historical implementation |
| [B4 #23](https://github.com/wojtekpiskorz/kiero/issues/23) | CLOSED | [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22), [B2 #21](https://github.com/wojtekpiskorz/kiero/issues/21) | Historical implementation |
| [C1 #24](https://github.com/wojtekpiskorz/kiero/issues/24) | CLOSED | [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22) | Historical implementation |
| [C2 #25](https://github.com/wojtekpiskorz/kiero/issues/25) | CLOSED | [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22) | Historical implementation |
| [C3 #26](https://github.com/wojtekpiskorz/kiero/issues/26) | CLOSED | [C2 #25](https://github.com/wojtekpiskorz/kiero/issues/25) | Historical implementation |
| [C4 #27](https://github.com/wojtekpiskorz/kiero/issues/27) | CLOSED | [C1 #24](https://github.com/wojtekpiskorz/kiero/issues/24), [C2 #25](https://github.com/wojtekpiskorz/kiero/issues/25) | Historical implementation |
| [C5 #28](https://github.com/wojtekpiskorz/kiero/issues/28) | CLOSED | [E3 #37](https://github.com/wojtekpiskorz/kiero/issues/37) | Historical implementation |
| [D1 #29](https://github.com/wojtekpiskorz/kiero/issues/29) | CLOSED | [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22) | Historical implementation |
| [D2 #30](https://github.com/wojtekpiskorz/kiero/issues/30) | CLOSED | [D1 #29](https://github.com/wojtekpiskorz/kiero/issues/29) | Historical implementation |
| [D3 #31](https://github.com/wojtekpiskorz/kiero/issues/31) | CLOSED | [D2 #30](https://github.com/wojtekpiskorz/kiero/issues/30), [B2 #21](https://github.com/wojtekpiskorz/kiero/issues/21) | Historical implementation |
| [D4 #32](https://github.com/wojtekpiskorz/kiero/issues/32) | CLOSED | [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19), [D2 #30](https://github.com/wojtekpiskorz/kiero/issues/30) | Historical implementation |
| [D5 #33](https://github.com/wojtekpiskorz/kiero/issues/33) | CLOSED | [D2 #30](https://github.com/wojtekpiskorz/kiero/issues/30) | Historical implementation |
| [D6 #34](https://github.com/wojtekpiskorz/kiero/issues/34) | CLOSED | [D2 #30](https://github.com/wojtekpiskorz/kiero/issues/30), [E2 #36](https://github.com/wojtekpiskorz/kiero/issues/36) | Historical implementation |
| [E1 #35](https://github.com/wojtekpiskorz/kiero/issues/35) | CLOSED | [A0 #65](https://github.com/wojtekpiskorz/kiero/issues/65) | Historical implementation |
| [E2 #36](https://github.com/wojtekpiskorz/kiero/issues/36) | CLOSED | [A3 #18](https://github.com/wojtekpiskorz/kiero/issues/18), [E1 #35](https://github.com/wojtekpiskorz/kiero/issues/35) | Historical implementation |
| [E3 #37](https://github.com/wojtekpiskorz/kiero/issues/37) | CLOSED | [C1 #24](https://github.com/wojtekpiskorz/kiero/issues/24), [C2 #25](https://github.com/wojtekpiskorz/kiero/issues/25), [D1 #29](https://github.com/wojtekpiskorz/kiero/issues/29), [E2 #36](https://github.com/wojtekpiskorz/kiero/issues/36) | Historical implementation |
| [E4 #38](https://github.com/wojtekpiskorz/kiero/issues/38) | CLOSED | [D5 #33](https://github.com/wojtekpiskorz/kiero/issues/33), [D6 #34](https://github.com/wojtekpiskorz/kiero/issues/34), [E3 #37](https://github.com/wojtekpiskorz/kiero/issues/37) | Historical implementation |
| [E5 #39](https://github.com/wojtekpiskorz/kiero/issues/39) | CLOSED | [C2 #25](https://github.com/wojtekpiskorz/kiero/issues/25), [D1 #29](https://github.com/wojtekpiskorz/kiero/issues/29), [E2 #36](https://github.com/wojtekpiskorz/kiero/issues/36) | Historical implementation |
| [E6 #40](https://github.com/wojtekpiskorz/kiero/issues/40) | CLOSED | [C3 #26](https://github.com/wojtekpiskorz/kiero/issues/26), [C4 #27](https://github.com/wojtekpiskorz/kiero/issues/27), [C5 #28](https://github.com/wojtekpiskorz/kiero/issues/28) | Historical implementation |
| [F1 #41](https://github.com/wojtekpiskorz/kiero/issues/41) | CLOSED | [D1 #29](https://github.com/wojtekpiskorz/kiero/issues/29) | Historical implementation |
| [F2 #42](https://github.com/wojtekpiskorz/kiero/issues/42) | CLOSED | [F1 #41](https://github.com/wojtekpiskorz/kiero/issues/41), [E3 #37](https://github.com/wojtekpiskorz/kiero/issues/37) | Historical implementation |
| [F3 #43](https://github.com/wojtekpiskorz/kiero/issues/43) | CLOSED | [F2 #42](https://github.com/wojtekpiskorz/kiero/issues/42), [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19), [B2 #21](https://github.com/wojtekpiskorz/kiero/issues/21) | Historical implementation |
| [F4 #44](https://github.com/wojtekpiskorz/kiero/issues/44) | CLOSED | [C4 #27](https://github.com/wojtekpiskorz/kiero/issues/27), [F2 #42](https://github.com/wojtekpiskorz/kiero/issues/42) | Historical implementation |
| [G1 #45](https://github.com/wojtekpiskorz/kiero/issues/45) | CLOSED | [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22) | Historical implementation |
| [G2 #46](https://github.com/wojtekpiskorz/kiero/issues/46) | CLOSED | [C4 #27](https://github.com/wojtekpiskorz/kiero/issues/27), [G1 #45](https://github.com/wojtekpiskorz/kiero/issues/45) | Historical implementation |
| [G3 #47](https://github.com/wojtekpiskorz/kiero/issues/47) | CLOSED | [G2 #46](https://github.com/wojtekpiskorz/kiero/issues/46) | Historical implementation |
| [G4 #48](https://github.com/wojtekpiskorz/kiero/issues/48) | CLOSED | [G3 #47](https://github.com/wojtekpiskorz/kiero/issues/47), [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19) | Historical implementation |
| [H1 #49](https://github.com/wojtekpiskorz/kiero/issues/49) | CLOSED | [F1 #41](https://github.com/wojtekpiskorz/kiero/issues/41), [J1 #60](https://github.com/wojtekpiskorz/kiero/issues/60) | Historical implementation |
| [H2 #50](https://github.com/wojtekpiskorz/kiero/issues/50) | CLOSED | [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19), [C3 #26](https://github.com/wojtekpiskorz/kiero/issues/26), [F4 #44](https://github.com/wojtekpiskorz/kiero/issues/44) | Historical implementation |
| [H3 #51](https://github.com/wojtekpiskorz/kiero/issues/51) | CLOSED | [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19), [E5 #39](https://github.com/wojtekpiskorz/kiero/issues/39), [D3 #31](https://github.com/wojtekpiskorz/kiero/issues/31), [C5 #28](https://github.com/wojtekpiskorz/kiero/issues/28) | Historical implementation |
| [H4 #52](https://github.com/wojtekpiskorz/kiero/issues/52) | CLOSED | [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19), [B4 #23](https://github.com/wojtekpiskorz/kiero/issues/23), [E3 #37](https://github.com/wojtekpiskorz/kiero/issues/37), [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54) | Historical implementation |
| [I1 #53](https://github.com/wojtekpiskorz/kiero/issues/53) | CLOSED | [A0 #65](https://github.com/wojtekpiskorz/kiero/issues/65) | Historical implementation |
| [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54) | CLOSED | [A3 #18](https://github.com/wojtekpiskorz/kiero/issues/18) | Historical implementation |
| [I3 #55](https://github.com/wojtekpiskorz/kiero/issues/55) | CLOSED | [C3 #26](https://github.com/wojtekpiskorz/kiero/issues/26), [C4 #27](https://github.com/wojtekpiskorz/kiero/issues/27), [D3 #31](https://github.com/wojtekpiskorz/kiero/issues/31) | Historical implementation |
| [I4 #56](https://github.com/wojtekpiskorz/kiero/issues/56) | CLOSED | [C5 #28](https://github.com/wojtekpiskorz/kiero/issues/28), [E5 #39](https://github.com/wojtekpiskorz/kiero/issues/39), [F3 #43](https://github.com/wojtekpiskorz/kiero/issues/43), [G3 #47](https://github.com/wojtekpiskorz/kiero/issues/47), [I3 #55](https://github.com/wojtekpiskorz/kiero/issues/55), [E4 #38](https://github.com/wojtekpiskorz/kiero/issues/38), [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54) | Historical implementation |
| [I5 #57](https://github.com/wojtekpiskorz/kiero/issues/57) | CLOSED | [D3 #31](https://github.com/wojtekpiskorz/kiero/issues/31), [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54) | Historical implementation |
| [I6 #58](https://github.com/wojtekpiskorz/kiero/issues/58) | OPEN | [I4 #56](https://github.com/wojtekpiskorz/kiero/issues/56), [I5 #57](https://github.com/wojtekpiskorz/kiero/issues/57), [I10 #137](https://github.com/wojtekpiskorz/kiero/issues/137) | Remaining execution |
| [I7 #59](https://github.com/wojtekpiskorz/kiero/issues/59) | CLOSED | [D4 #32](https://github.com/wojtekpiskorz/kiero/issues/32), [F3 #43](https://github.com/wojtekpiskorz/kiero/issues/43), [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54) | Historical implementation |
| [J1 #60](https://github.com/wojtekpiskorz/kiero/issues/60) | CLOSED | [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19), [E3 #37](https://github.com/wojtekpiskorz/kiero/issues/37) | Historical implementation |
| [J2 #61](https://github.com/wojtekpiskorz/kiero/issues/61) | CLOSED | [D4 #32](https://github.com/wojtekpiskorz/kiero/issues/32), [E4 #38](https://github.com/wojtekpiskorz/kiero/issues/38), [E6 #40](https://github.com/wojtekpiskorz/kiero/issues/40), [H2 #50](https://github.com/wojtekpiskorz/kiero/issues/50), [H3 #51](https://github.com/wojtekpiskorz/kiero/issues/51), [H4 #52](https://github.com/wojtekpiskorz/kiero/issues/52), [H1 #49](https://github.com/wojtekpiskorz/kiero/issues/49) | Historical implementation |
| [J3 #62](https://github.com/wojtekpiskorz/kiero/issues/62) | OPEN | [J2 #61](https://github.com/wojtekpiskorz/kiero/issues/61), [J6 #139](https://github.com/wojtekpiskorz/kiero/issues/139) | Remaining execution |
| [J4 #63](https://github.com/wojtekpiskorz/kiero/issues/63) | OPEN | [J2 #61](https://github.com/wojtekpiskorz/kiero/issues/61), [G4 #48](https://github.com/wojtekpiskorz/kiero/issues/48), [G5 #107](https://github.com/wojtekpiskorz/kiero/issues/107), [I7 #59](https://github.com/wojtekpiskorz/kiero/issues/59), [J6 #139](https://github.com/wojtekpiskorz/kiero/issues/139) | Remaining execution |
| [J5 #64](https://github.com/wojtekpiskorz/kiero/issues/64) | OPEN | [I6 #58](https://github.com/wojtekpiskorz/kiero/issues/58), [J3 #62](https://github.com/wojtekpiskorz/kiero/issues/62), [J4 #63](https://github.com/wojtekpiskorz/kiero/issues/63), [I9 #136](https://github.com/wojtekpiskorz/kiero/issues/136), [I11 #138](https://github.com/wojtekpiskorz/kiero/issues/138), [M1 #141](https://github.com/wojtekpiskorz/kiero/issues/141), [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166), [M3 #175](https://github.com/wojtekpiskorz/kiero/issues/175), [M4 #183](https://github.com/wojtekpiskorz/kiero/issues/183), [M5 #190](https://github.com/wojtekpiskorz/kiero/issues/190), [M6 #195](https://github.com/wojtekpiskorz/kiero/issues/195), [M7 #199](https://github.com/wojtekpiskorz/kiero/issues/199), [M8 #202](https://github.com/wojtekpiskorz/kiero/issues/202), [M9 #207](https://github.com/wojtekpiskorz/kiero/issues/207), [M10 #211](https://github.com/wojtekpiskorz/kiero/issues/211), [M11 #216](https://github.com/wojtekpiskorz/kiero/issues/216) | Remaining execution |
| [G5 #107](https://github.com/wojtekpiskorz/kiero/issues/107) | CLOSED | [G2 #46](https://github.com/wojtekpiskorz/kiero/issues/46), [G4 #48](https://github.com/wojtekpiskorz/kiero/issues/48) | Historical implementation |
| [E7 #115](https://github.com/wojtekpiskorz/kiero/issues/115) | CLOSED | [C5 #28](https://github.com/wojtekpiskorz/kiero/issues/28), [H3 #51](https://github.com/wojtekpiskorz/kiero/issues/51) | Historical implementation |
| [R1 #126](https://github.com/wojtekpiskorz/kiero/issues/126) | CLOSED | [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [C2 #25](https://github.com/wojtekpiskorz/kiero/issues/25), [E6 #40](https://github.com/wojtekpiskorz/kiero/issues/40), [H1 #49](https://github.com/wojtekpiskorz/kiero/issues/49), [H2 #50](https://github.com/wojtekpiskorz/kiero/issues/50) | Remaining execution |
| [R2 #127](https://github.com/wojtekpiskorz/kiero/issues/127) | CLOSED | [R1 #126](https://github.com/wojtekpiskorz/kiero/issues/126), [I4 #56](https://github.com/wojtekpiskorz/kiero/issues/56) | Remaining execution |
| [R3 #128](https://github.com/wojtekpiskorz/kiero/issues/128) | CLOSED | [R2 #127](https://github.com/wojtekpiskorz/kiero/issues/127), [F3 #43](https://github.com/wojtekpiskorz/kiero/issues/43), [F4 #44](https://github.com/wojtekpiskorz/kiero/issues/44) | Remaining execution |
| [R4 #129](https://github.com/wojtekpiskorz/kiero/issues/129) | CLOSED | [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [E7 #115](https://github.com/wojtekpiskorz/kiero/issues/115) | Remaining execution |
| [R5 #130](https://github.com/wojtekpiskorz/kiero/issues/130) | CLOSED | [R1 #126](https://github.com/wojtekpiskorz/kiero/issues/126), [H3 #51](https://github.com/wojtekpiskorz/kiero/issues/51) | Remaining execution |
| [R6 #131](https://github.com/wojtekpiskorz/kiero/issues/131) | CLOSED | [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [I7 #59](https://github.com/wojtekpiskorz/kiero/issues/59) | Remaining execution |
| [R7 #132](https://github.com/wojtekpiskorz/kiero/issues/132) | CLOSED | [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [G3 #47](https://github.com/wojtekpiskorz/kiero/issues/47) | Remaining execution |
| [I8 #133](https://github.com/wojtekpiskorz/kiero/issues/133) | CLOSED | [R6 #131](https://github.com/wojtekpiskorz/kiero/issues/131), [I1 #53](https://github.com/wojtekpiskorz/kiero/issues/53), [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54), [R9 #168](https://github.com/wojtekpiskorz/kiero/issues/168), [E8 #170](https://github.com/wojtekpiskorz/kiero/issues/170), [R15 #192](https://github.com/wojtekpiskorz/kiero/issues/192) | Remaining execution |
| [B5 #134](https://github.com/wojtekpiskorz/kiero/issues/134) | OPEN | [I8 #133](https://github.com/wojtekpiskorz/kiero/issues/133), [B2 #21](https://github.com/wojtekpiskorz/kiero/issues/21), [B3 #22](https://github.com/wojtekpiskorz/kiero/issues/22), [B4 #23](https://github.com/wojtekpiskorz/kiero/issues/23), [R18 #213](https://github.com/wojtekpiskorz/kiero/issues/213), [R26 #232](https://github.com/wojtekpiskorz/kiero/issues/232), [R31 #244](https://github.com/wojtekpiskorz/kiero/issues/244) | Remaining execution |
| [D7 #135](https://github.com/wojtekpiskorz/kiero/issues/135) | OPEN | [I8 #133](https://github.com/wojtekpiskorz/kiero/issues/133), [D5 #33](https://github.com/wojtekpiskorz/kiero/issues/33), [D6 #34](https://github.com/wojtekpiskorz/kiero/issues/34), [E4 #38](https://github.com/wojtekpiskorz/kiero/issues/38), [D3 #31](https://github.com/wojtekpiskorz/kiero/issues/31), [R19 #218](https://github.com/wojtekpiskorz/kiero/issues/218), [R20 #220](https://github.com/wojtekpiskorz/kiero/issues/220), [R21 #222](https://github.com/wojtekpiskorz/kiero/issues/222), [R22 #224](https://github.com/wojtekpiskorz/kiero/issues/224), [R23 #225](https://github.com/wojtekpiskorz/kiero/issues/225), [R24 #229](https://github.com/wojtekpiskorz/kiero/issues/229), [R25 #230](https://github.com/wojtekpiskorz/kiero/issues/230), [R30 #242](https://github.com/wojtekpiskorz/kiero/issues/242) | Remaining execution |
| [I9 #136](https://github.com/wojtekpiskorz/kiero/issues/136) | OPEN | [R3 #128](https://github.com/wojtekpiskorz/kiero/issues/128), [D7 #135](https://github.com/wojtekpiskorz/kiero/issues/135), [I3 #55](https://github.com/wojtekpiskorz/kiero/issues/55), [R5 #130](https://github.com/wojtekpiskorz/kiero/issues/130), [R17 #209](https://github.com/wojtekpiskorz/kiero/issues/209) | Remaining execution |
| [I10 #137](https://github.com/wojtekpiskorz/kiero/issues/137) | OPEN | [R3 #128](https://github.com/wojtekpiskorz/kiero/issues/128), [D7 #135](https://github.com/wojtekpiskorz/kiero/issues/135), [I5 #57](https://github.com/wojtekpiskorz/kiero/issues/57) | Remaining execution |
| [I11 #138](https://github.com/wojtekpiskorz/kiero/issues/138) | OPEN | [I8 #133](https://github.com/wojtekpiskorz/kiero/issues/133), [I2 #54](https://github.com/wojtekpiskorz/kiero/issues/54), [R27 #235](https://github.com/wojtekpiskorz/kiero/issues/235), [R28 #236](https://github.com/wojtekpiskorz/kiero/issues/236), [R29 #237](https://github.com/wojtekpiskorz/kiero/issues/237) | Remaining execution |
| [J6 #139](https://github.com/wojtekpiskorz/kiero/issues/139) | OPEN | [R3 #128](https://github.com/wojtekpiskorz/kiero/issues/128), [R4 #129](https://github.com/wojtekpiskorz/kiero/issues/129), [R5 #130](https://github.com/wojtekpiskorz/kiero/issues/130), [R7 #132](https://github.com/wojtekpiskorz/kiero/issues/132), [D7 #135](https://github.com/wojtekpiskorz/kiero/issues/135), [B5 #134](https://github.com/wojtekpiskorz/kiero/issues/134), [R10 #171](https://github.com/wojtekpiskorz/kiero/issues/171), [R12 #181](https://github.com/wojtekpiskorz/kiero/issues/181), [R13 #182](https://github.com/wojtekpiskorz/kiero/issues/182), [R14 #187](https://github.com/wojtekpiskorz/kiero/issues/187), [R16 #198](https://github.com/wojtekpiskorz/kiero/issues/198), [R18 #213](https://github.com/wojtekpiskorz/kiero/issues/213) | Remaining execution |
| [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125) | CLOSED | None | Map administration |
| [M1 #141](https://github.com/wojtekpiskorz/kiero/issues/141) | CLOSED | [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125) | Map administration |
| [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166) | CLOSED | [M1 #141](https://github.com/wojtekpiskorz/kiero/issues/141) | Map administration |
| [M3 #175](https://github.com/wojtekpiskorz/kiero/issues/175) | CLOSED | [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166) | Map administration |
| [M4 #183](https://github.com/wojtekpiskorz/kiero/issues/183) | CLOSED | [M3 #175](https://github.com/wojtekpiskorz/kiero/issues/175) | Map administration |
| [M5 #190](https://github.com/wojtekpiskorz/kiero/issues/190) | CLOSED | [M4 #183](https://github.com/wojtekpiskorz/kiero/issues/183) | Map administration |
| [M6 #195](https://github.com/wojtekpiskorz/kiero/issues/195) | CLOSED | [M5 #190](https://github.com/wojtekpiskorz/kiero/issues/190) | Map administration |
| [M7 #199](https://github.com/wojtekpiskorz/kiero/issues/199) | CLOSED | [M6 #195](https://github.com/wojtekpiskorz/kiero/issues/195) | Map administration |
| [M8 #202](https://github.com/wojtekpiskorz/kiero/issues/202) | CLOSED | [M7 #199](https://github.com/wojtekpiskorz/kiero/issues/199) | Map administration |
| [M9 #207](https://github.com/wojtekpiskorz/kiero/issues/207) | CLOSED | [M8 #202](https://github.com/wojtekpiskorz/kiero/issues/202) | Map administration |
| [M10 #211](https://github.com/wojtekpiskorz/kiero/issues/211) | CLOSED | [M9 #207](https://github.com/wojtekpiskorz/kiero/issues/207) | Map administration |
| [M11 #216](https://github.com/wojtekpiskorz/kiero/issues/216) | CLOSED | [M10 #211](https://github.com/wojtekpiskorz/kiero/issues/211) | Map administration |
| [R8 #167](https://github.com/wojtekpiskorz/kiero/issues/167) | CLOSED | [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166), [R6 #131](https://github.com/wojtekpiskorz/kiero/issues/131), [I1 #53](https://github.com/wojtekpiskorz/kiero/issues/53), [A4 #19](https://github.com/wojtekpiskorz/kiero/issues/19) | Remaining execution |
| [R9 #168](https://github.com/wojtekpiskorz/kiero/issues/168) | CLOSED | [R8 #167](https://github.com/wojtekpiskorz/kiero/issues/167), [R6 #131](https://github.com/wojtekpiskorz/kiero/issues/131) | Remaining execution |
| [R11 #169](https://github.com/wojtekpiskorz/kiero/issues/169) | CLOSED | [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166), [B1 #20](https://github.com/wojtekpiskorz/kiero/issues/20) | Remaining execution |
| [E8 #170](https://github.com/wojtekpiskorz/kiero/issues/170) | CLOSED | [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166), [E2 #36](https://github.com/wojtekpiskorz/kiero/issues/36), [R11 #169](https://github.com/wojtekpiskorz/kiero/issues/169) | Remaining execution |
| [R10 #171](https://github.com/wojtekpiskorz/kiero/issues/171) | CLOSED | [M2 #166](https://github.com/wojtekpiskorz/kiero/issues/166), [G1 #45](https://github.com/wojtekpiskorz/kiero/issues/45) | Remaining execution |
| [R12 #181](https://github.com/wojtekpiskorz/kiero/issues/181) | CLOSED | [R10 #171](https://github.com/wojtekpiskorz/kiero/issues/171) | Remaining execution |
| [R13 #182](https://github.com/wojtekpiskorz/kiero/issues/182) | CLOSED | [R10 #171](https://github.com/wojtekpiskorz/kiero/issues/171), [R12 #181](https://github.com/wojtekpiskorz/kiero/issues/181) | Remaining execution |
| [R14 #187](https://github.com/wojtekpiskorz/kiero/issues/187) | CLOSED | [E8 #170](https://github.com/wojtekpiskorz/kiero/issues/170) | Remaining execution |
| [R15 #192](https://github.com/wojtekpiskorz/kiero/issues/192) | CLOSED | [R9 #168](https://github.com/wojtekpiskorz/kiero/issues/168) | Remaining execution |
| [C6 #197](https://github.com/wojtekpiskorz/kiero/issues/197) | OPEN | [J5 #64](https://github.com/wojtekpiskorz/kiero/issues/64) | Remaining execution |
| [R16 #198](https://github.com/wojtekpiskorz/kiero/issues/198) | CLOSED | None | Remaining execution |
| [R17 #209](https://github.com/wojtekpiskorz/kiero/issues/209) | CLOSED | None | Repair |
| [R18 #213](https://github.com/wojtekpiskorz/kiero/issues/213) | CLOSED | None | Repair |
| [R19 #218](https://github.com/wojtekpiskorz/kiero/issues/218) | CLOSED | None | Repair |
| [R20 #220](https://github.com/wojtekpiskorz/kiero/issues/220) | CLOSED | None | Repair |
| [R21 #222](https://github.com/wojtekpiskorz/kiero/issues/222) | CLOSED | None | Repair |
| [R22 #224](https://github.com/wojtekpiskorz/kiero/issues/224) | CLOSED | None | Repair |
| [R23 #225](https://github.com/wojtekpiskorz/kiero/issues/225) | CLOSED | None | Repair |
| [R24 #229](https://github.com/wojtekpiskorz/kiero/issues/229) | CLOSED | None | Repair |
| [R25 #230](https://github.com/wojtekpiskorz/kiero/issues/230) | OPEN | None | Repair |
| [R26 #232](https://github.com/wojtekpiskorz/kiero/issues/232) | CLOSED | None | Repair |
| [R27 #235](https://github.com/wojtekpiskorz/kiero/issues/235) | CLOSED | None | Repair |
| [R28 #236](https://github.com/wojtekpiskorz/kiero/issues/236) | OPEN | [R27 #235](https://github.com/wojtekpiskorz/kiero/issues/235) | Repair |
| [R29 #237](https://github.com/wojtekpiskorz/kiero/issues/237) | OPEN | [R28 #236](https://github.com/wojtekpiskorz/kiero/issues/236) | Repair |
| [R30 #242](https://github.com/wojtekpiskorz/kiero/issues/242) | OPEN | None | Remaining execution |
| [R31 #244](https://github.com/wojtekpiskorz/kiero/issues/244) | OPEN | None | Remaining execution |

Administration rows are documentation work, not core features. Their cached states change only through bounded administration PRs that rerun the audit and keep every derived cell equal to the manifest.
