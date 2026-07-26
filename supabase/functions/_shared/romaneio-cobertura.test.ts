// Guard onda1 (25/07, NF 158084): cobertura do romaneio por filename.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { anexosCobremRomaneio } from "./romaneio-cobertura.ts";

const ROM = "Sal 17-07_260717_145833.pdf"; // romaneio REAL da NF 158084

Deno.test("ÂNCORA NF 158084: páginas convertidas pelo modal cobrem o romaneio", () => {
  assertEquals(anexosCobremRomaneio(["Sal_17-07_260717_145833_p1.jpg"], ROM), true);
  assertEquals(anexosCobremRomaneio(["Sal_17-07_260717_145833_p2.jpg", "Sal_17-07_260717_145833_p3.jpg"], ROM), true);
});

Deno.test("romaneio imagem: o próprio arquivo cobre (match exato, case-insensitive)", () => {
  assertEquals(anexosCobremRomaneio(["ROMANEIO.JPG"], "romaneio.jpg"), true);
});

Deno.test("assinatura PNG NÃO cobre o romaneio (a raiz do bug)", () => {
  assertEquals(anexosCobremRomaneio(["image001.png"], ROM), false);
  assertEquals(anexosCobremRomaneio([], ROM), false);
  assertEquals(anexosCobremRomaneio(["image001.png"], null), false);
});
