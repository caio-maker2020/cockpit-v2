#!/usr/bin/env python3
"""
import_victor_isakarol.py - Onboarding 2026-06-15 (Caio).

Adiciona/atualiza 2 operadores e importa carteiras:
- VICTOR (atualiza seed) - segmentos 006/008/011 - login victor.costa@salexpress.com.br
- ISA E KAROL (cria; conta compartilhada Karol+Isabelly) - segmento 043 CURVA F -
  login sac@salexpress.com.br, outbound "Karol e Isabelly"

Faz, por operador:
1. Cria auth.users (senha sal123456, email confirmado) se nao existir -> user_id
2. UPSERT/INSERT operadores (email, email_relacionamento, nome_email_outbound, segmentos, user_id, cockpit_ativo=false)
3. UPSERT clientes
4. INSERT contatos_cliente (apos DELETE idempotente por operador)
5. PATCH operadores SET carteira/segmentos

cockpit_ativo fica FALSE - ligar so apos validar 1 NF real de cada no SSW.

SSW: reusa conta AI.SALEX (secrets SSW_INTERNAL_VICTOR_* e SSW_INTERNAL_ISA_E_KAROL_*).

Uso:
  set -a && source .env.local && set +a
  python3 scripts/import_victor_isakarol.py
"""
import json, os, sys, requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
HJ = {**H, "Content-Type": "application/json"}

DADOS_VICTOR = [
    ('43854777000550', 'BUNZL EQUIPAMENTOS - CONTAGEM', ['simone.alves@casadoepi.com.br']),
    ('43854777000126', 'BUNZL EQUIPAMENTOS - GUARULHOS', ['maria.solange@protcap.com.br']),
    ('66288002001027', 'PLATINA COSM S A', ['lmendes@farmativa.ind.br']),
    ('00747829000152', 'SOARES E TECLES COMERCIO E REP', ['leticia@naturalsuplementos.com.br']),
    ('02164848000181', 'BIM DISTRIBUIDORA LTDA - MATRIZ', ['guilherme.cetra@bimdistribuidora.com.br']),
    ('45143429000176', 'UNION MEDIC COMERCIO E REPRESENTACAO DE PRODUTOS PARA A SAUD', ['a.sergio@distribuidoraunion.com.br']),
    ('59609123001220', 'SP EQUIPAMENTOS DE PROT TRAB E', ['expedicao@spequipamentos.com.br']),
    ('40150481000136', 'DMDC DISTR MIN DE COSM', ['adriano.lima@alfaparfdbdc.com.br']),
    ('10702092000709', 'VCH - IMPORTADORA, EXP.E DIST. DE PRODUTOS LT', ['torredecontrolesp@bunzlhigiene.com.br']),
    ('43707279000231', 'SUPER INDUSTRIA DE ALIMENTOS LTDA 02', ['igor.araujo@caffeinearmy.com.br']),
    ('14118680000408', 'BEAUTYBIZ COMERCIO DE PRODUTOS', ['entregas2@gerapartner.com.br']),
    ('27153141000281', 'LDI SAFETY', ['comercial11@ldisafety.com.br']),
    ('03662136000155', 'DENTAL SORRIA LTDA', ['lucas.gastaldi@dentalsorria.com.br']),
    ('00204589000301', 'KALIPSO EQUIPAMENTOS INDIVIDUAIS DE PROTECAO LTDA', ['atendimento.kalipso@xpertplan.com.br']),
    ('07455576000940', 'VIDA FORTE NUTRIENTES INDUSTRIA E COMERCIO DE PRODUTOS NATUR', ['karen.veiga@vitafor.com.br']),
    ('20102722000164', 'FORTPEL COMERCIO DE DESCARTAVEIS LTDA', ['logistica06.sp@fortpel.com.br']),
    ('12463472000402', 'IMA EQUIPAMENTOS DE PROTECAO INDIVIDUAL LTDA', ['acompanhamento@imaepis.com.br']),
    ('18890413000154', 'D2MARTINS DISTRIBUIDORA DE SUPLEMENTOS LTDA', ['joaod2suplementos@gmail.com']),
    ('63238082000127', 'NOVA ERA UTILIDADES LTDA', ['lotuscosmeticosmg@gmail.com']),
    ('25464260000572', 'NEOBETEL EPI, EQUIPAMENTOS DE PROTECAO INDIVIDUAL LTDA', ['diego.sousa@neobetel.com.br']),
    ('06997850000192', 'NUTRENDS LTDA', ['contato@nutrends.com.br']),
    ('18203461000127', 'VIP SPORTS NUTRITION COMERCIO', ['nfe@vipshowroom.com.b']),
    ('32609764000175', 'CSC COSMETICOS LTDA', []),
    ('12087851000100', 'BR BRAND S/A', ['aressa.pires@brbrand.com.b']),
    ('46099856000167', 'RIDANA MAKEUP LTDA', ['vendas@ridana.com.br']),
    ('28965704000118', 'MDC DISTRIBUIDORA COMERCIAL LTDA', ['mascarenhasdistribuidora@gmail.com']),
    ('00747829000152', 'SOARES E TECLES COMERCIO (B.)', ['leticia@naturalsuplementos.com.br']),
    ('09412147000163', 'DS DISTRIBUIDORA LTDA ME', ['ds.haskellsac@yahoo.com.br']),
    ('36254750000137', 'RESENDE E SILVA COMERCIO DE SUPLEMENTOS ALIMENTARES EIRELI', ['resendesilvadsa@gmail.com']),
    ('10702092000709', 'VCH - IMPORTADORA, EXP.E DIST.', ['torredecontrolesp@bunzlhigiene.com.br']),
    ('31893116000120', 'BHZ EPI DISTRIBUIDORA LTDA', []),
    ('24566797000904', 'LOLLIPOPS COSMETICS DIST. DE C', ['fmsilva@farmativa.ind.br']),
]

DADOS_ISA_KAROL = [
    ('63982896000414', 'ABASE COMERCIO E REPRESENTACOES LTDA', ['beatriz.menezes@covetrus.com']),
    ('10333316000310', 'ACERO PRODUTOS AGRICOLAS LTDA.', ['adm@gmdagro.com.br']),
    ('30952911000180', 'AGROFERT INSUMOS AGRICOLAS LTDA', []),
    ('71171060000115', 'ANNEL DISTRIBUIDORA LTDA', ['logistica@annel.com.br']),
    ('16517294000163', 'ASSIS E ASSIS LTDA', ['distribuicao@assiseassis.com.br', 'loja@assiseassis.com.br']),
    ('50949528000180', 'ASTRA S/A IND E COM', ['pendencialog@astra-sa.com']),
    ('40279136000288', 'ATACADAO DAS FERRAMENTAS LTDA', ['sac.transportadora@grupofn.com.br']),
    ('16655485000191', 'ATACAR DISTRIBUIDORA DE MATERI', ['atacar.venda@gmail.com']),
    ('09244969001235', 'AURORA COMERCIO E DISTRIBUICAO', ['antonino.oliveira@auroradistribuicao.com.br']),
    ('50240941000170', 'AVVA LAB PRODUTOS PARA LABORATORIO LTDA', ['avvalab@gmail.com']),
    ('52780376000593', 'B.A.P. AUTOMOTIVA LTDA.', ['barrosbhnfe@barros.com.br', 'transportadora@barros.com.br']),
    ('12087851000100', 'BR BRAND S/A', ['aressa.pires@brbrand.com.b']),
    ('55831184000476', 'BRUDOVAN PNEUS LTDA', ['cd.mg@brudovan.com.br']),
    ('08415503000130', 'C R FILHO MOTO PECAS DISTRIBUI', ['crfilho2010@bol.com.br']),
    ('18977975000300', 'CASA DA RACAO VETERINARIA', ['faturamento@cdrdistribuicao.com.br']),
    ('23480536000319', 'CASA RURALISTA LTDA', ['diretoriarededesenvolvevet@gmail.com']),
    ('31995028000130', 'CD DISTRIBUIDORA LTDA', ['logistica@cdtintas.com']),
    ('05286344000556', 'CENTERDIESEL AUTO PECAS LTDA', ['apagar.novacenter@gmail.com', 'sac.enovavarejo@gmail.com']),
    ('61834834000278', 'CENTERPARTS DISTRIB. DE AUTO P', ['fernando.santos@centerparts.com.br', 'sac@centerparts.com.br']),
    ('61834834000278', 'CENTERPARTS DISTRIB. DE AUTO P', ['sac@centerparts.com.br']),
    ('55176358000323', 'CHG AUTOMOTIVA LTDA', ['adriele.paixao@chg.com.br']),
    ('55176358000323', 'CHG AUTOMOTIVA LTDA', ['guilherme.ribeiro@chg.com.br']),
    ('55176358000323', 'CHG AUTOMOTIVA LTDA', ['suelen.silva@chg.com.br', 'transportesmg@chg.com.br']),
    ('24578917000136', 'CICLOVIX IMPORTACAO E DISTRIBU', ['cobranca@ciclovix.com']),
    ('55173415000159', 'CIRURGICA ESSENCIAL E SAUDE LTDA', ['cirurgicaessencialesaude@gmail.com']),
    ('58248352003085', 'COBRA ROLAMENTOS E AUTOPECAS', ['encarregado28@cobrarolamentos.com.br', 'rodrigoferreira@cobrarolamentos.com.br']),
    ('58248352000302', 'COBRA ROLAMENTOS E AUTOPECAS L', ['encarregado28@cobrarolamentos.com.br', 'rodrigoferreira@cobrarolamentos.com.br']),
    ('17555540000134', 'COLINA VERDE AGROCOMERCIAL LTD (C.)', ['adm@colinaverde.vet.br']),
    ('68647312000630', 'COMDIP COMERCIAL DISTRIBUIDORA', ['bruno.abreu@comdip.com.br']),
    ('68647312000630', 'COMDIP COMERCIAL DISTRIBUIDORA', []),
    ('68647312000630', 'COMDIP COMERCIAL DISTRIBUIDORA', ['julianaps@comdip.com.br']),
    ('03386019000106', 'COMPROMISSO COM E DISTRIB LTDA (C.)', ['assistfaturamento@compromissopet.com.br']),
    ('05855108000180', 'CONECTA COMPONENTES AUTOMOTIVO', ['conectafiltrosepecas@gmail.com']),
    ('18890413000154', 'D2MARTINS DISTRIBUIDORA DE SUPLEMENTOS LTDA', ['joaod2suplementos@gmail.com']),
    ('71213086000189', 'DENTAL TIRADENTES LTDA', ['claudiney@dentaltiradentes.com.br']),
    ('17728649000126', 'DENTAL UAI LTDA', ['dentaluai10@gmail.com']),
    ('58322019000134', 'DIAGLIFE HOSPITALAR LTDA', ['administrativo@diaglife.com.br']),
    ('21437447010912', 'DINAC - MANHUACU', ['paulo.felisberto@adubosreal.com.br']),
    ('29285082000140', 'DISAGRO DISTRIBUIDORA DE PRODU', ['logistica03@grupoagromg.com.br']),
    ('19805900000134', 'DISTRIBUIDORA DE PRODUTOS FARMACEUTICOS VALLE MED LTDA', ['transporte@disvet.vet.br']),
    ('16366888000110', 'DISTRIBUIDORA DE PRODUTOS ODON', ['transporte@disvet.vet.br']),
    ('10961814000146', 'DISTRIBUIDORA VITORINO COMERCI', ['financeiro@vitorinoatacadista.com']),
    ('04889013000203', 'DISTRILAF DIST DE MEDIC LTDA', ['dayane@distrilaf.com.br']),
    ('01417694000120', 'DISTRIMIX DIST DE MEDIC LTDA', ['jhonatan.sales@hotmail.com']),
    ('32986368000167', 'DISTRIPARTS COMERCIAL DE PECAS', ['distriparts.comercial@gmail.com', 'distriparts.expedicao@gmail.com']),
    ('07115024000135', 'DORNAS SUPRIMENTOS VETERINARIO (C3)', ['comercial@dornas.vet.br']),
    ('26760171000102', 'DRM - DISTRIBUIDORA REGIONAL DE MEDICAMENTOS LTDA', ['fiscaldrmdistribuidora@gmail.com']),
    ('09412147000163', 'DS DISTRIBUIDORA LTDA ME', ['ds.haskellsac@yahoo.com.br']),
    ('44949429000367', 'DWD COMPONENTES - FILIAL MG', ['contato@dwdautomotive.com.br', 'transporte@dwdautomotive.com.br']),
    ('10238827000191', 'EDEILSON CASSIMIRO DOS SANTOS', ['zelinha.santos@outlook.com']),
    ('08998535000539', 'EMDISA DISTRIBUIDORA LTDA', ['logistica2@emdisa.com.br']),
    ('41227007000128', 'FARMACOR MATERIAIS E EQUIPAMENTOS CIRURGICOS LTDA', ['expedicao@multifarma.com.br']),
    ('61247612000178', 'FORT LUB DISTRIBUIDORA LTDA', ['adm.ctg@fortlub.com', 'cte.700@fortlub.com']),
    ('44039854000238', 'FRIORIO DISTRIBUIDOR DE PECAS PARA REFRIGERACAO E', ['faturamento@friorio.com.br']),
    ('04098359000447', 'G.M.I. DISTRIBUIDORA LTDA', ['logistica02@gmibh.com']),
    ('01702499000141', 'GARRAFIX PECAS DE FIXACAO AUTO', ['envionfe@garrafix.com.br']),
    ('01702499000141', 'GARRAFIX PECAS DE FIXACAO AUTO', ['envionfe@garrafix.com.br']),
    ('02281998000175', 'GEBOR COMERCIAL LTDA', ['estoque@gebor.com.br']),
    ('53494054000206', 'GEDAN COMERCIO INTERNACIONAL DE PECAS AUTOMOT', ['financeiromundialalternadores2@gmail.com', 'financeiromundialalternadores@gmail.com']),
    ('07787722000187', 'GERAESVET DISTRIB.PROD.AGROPEC', ['faturamento@geraesvet.com.br']),
    ('49288407000155', 'GET AGRO DISTRIBUICAO, COMERCIO E REPRESENTACAO DE AGRONEGOC', ['comercial@getagro.com.br']),
    ('81676009001190', 'GIRANDO COMERCIO DE PECAS LTDA', ['contagem@rolemar.com', 'vendas.contagem@rolemar.com']),
    ('81676009001433', 'GIRANDO COMERCIO DE PECAS LTDA (C.) - UDI', ['gerente.uberlandia@rolemar.com', 'vendas.uberlandia@rolemar.com']),
    ('32255815000108', 'GMD AGRONEGOCIOS LTDA.', ['adm@gmdagro.com.br']),
    ('10939316000105', 'GOLDEN COMPONENTES AUTOMOTIVOS', ['caiohenrique@golden.ind.br', 'operacao.golden@grupotransp.com.br']),
    ('32098703000190', 'GOMES SUPLEMENTOS ALIMENTARES LTDA', ['administrativo3@gsa.net.br']),
    ('18243891000172', 'GOW HELMETS INDUSTRIA E COMERCIO LTDA', ['rma@ciclocairu.com.br']),
    ('15082489000165', 'HANBAI COMERCIO DE MOTOS LTDA.', ['pedropereira@hanbaimotos.com.br']),
    ('11872656000200', 'HDL LOGISTICA HOSPITALAR LTDA.', ['transporte.udi@hdlhospitalar.com.br']),
    ('36447719000112', 'HIGLOG COMERCIO E DISTRIBUICAO DE PRODUTOS DE LIMPEZA EIRELI', ['logistica@higilog.com.br']),
    ('37950696000127', 'HL DISTRIBUICAO MATRIZ', ['sac@hlmotobike.com.br']),
    ('37950696000208', 'HL DISTRIBUIDORA MOTO BIKE LTD', ['sac@hlmotobike.com.br']),
    ('35909317000120', 'IBITURUNA COM PROD FARMACEUTICOS LTDA', ['compras2@ibiturunadistribuidora.com.br']),
    ('57713530000102', 'IMPERA COMERCIO DE PECAS E FILTROS LTDA', ['jairlubrific@gmail.com']),
    ('18365734000130', 'INDUBRAS IND VETERINARIA S/A', ['rastreamento@indubras.vet.br']),
    ('65339590000127', 'INDUSAT INDUSTRIA E COMERCIO L', ['denise@indusat.com.br']),
    ('08673321000754', 'INOVA EQUIPAMENTOS LTDA', ['victor.silva@inovamaquinas.com']),
    ('27826219000109', 'INOVACAO PET DISTRIBUIDORA EIRELI', ['comercial@solucaopetmg.com.br']),
    ('49051659000166', 'IPEBRAL IRMAOS PEDROSA BRAGA L', ['faturamento4@ipebral.com.bR']),
    ('37591061000180', 'JD DISTRIBUIDORA DE BRINQUEDOS', ['jdimports20@gmail.com']),
    ('68534817000345', 'JECAL PRODUTOS AGROPECUARIOS LTDA', []),
    ('00794163000193', 'JP DIAGNOSTICA LTDA', ['logistica@jpdiagnostica.com.br']),
    ('49322827000100', 'KALANGO DISTRIBUIDORA MOTO PEC', ['admkalangodistribuidora@gmail.com']),
    ('47915446000100', 'L E C DISTRIBUIDORA DE PRODUTOS NUTRICI46NAIS LTDA', ['comercial2@lifenutri.com.br']),
    ('13578060000138', 'L&C DISTRIBUIDORA EIRELI ME', ['lopesdistribuidorahaskell@gmail.com']),
    ('15398703000197', 'LAB COMPRAS LTDA - EPP', ['alexandro.poleze@unionlab.com.br']),
    ('23050579000100', 'LAGOA MOTO PECAS LTDA - ME (C3 (C.)', ['lagoa.motopecaslp@gmail.com']),
    ('60351003000100', 'LAS CASAS EPI LTDA', ['administrativo@bhzepi.com.br', 'jeane.adm@bhzepi.com.br']),
    ('44543152000106', 'LBS COMERCIAL LTDA', ['lbscomercial22@gmail.com']),
    ('35484884000181', 'LEALFARMA PRODUTOS HOSPITALARES LTDA', ['expedicao@multifarma.com.br']),
    ('40021146000138', 'LEONE E COLDIBELLI COM. E DIST (C.)', ['comercial2@lifenutri.com.br', 'comercial3@lifenutri.com.br']),
    ('42092745000178', 'LOGAR LOGISTICA LTDA', ['logistica@redeinovadrogarias.com']),
    ('25909961000144', 'LOJA DO BORRACHEIRO DIST. LTDA', ['fiscaludi@lojadoborracheiro.com', 'vendasudi@lojadoborracheiro.com']),
    ('50276898000446', 'LUPORINI DISTRIBUIDORA DE AUTO', ['esfaturamento@luporini.com.br', 'sac.es@luporini.com.br']),
    ('02658379000319', 'LWM AUTO ATACADO LTDA', ['expedicao@lwmatacado.com.br', 'fiscal@lwmatacado.com.br']),
    ('51107246000106', 'MAMUTE COMERCIO E IMPORTACAO L', ['financeiro@mamuteprodutos.com.br']),
    ('71368807000634', 'MARINHO E MONTEIRO LTDA (C.) ( (C.)', ['comercial@nutreminas.com.br']),
    ('11470579000172', 'MAX BABY DISTRIBUIDORA DE PROD', ['danielmaxbaby@hotmail.com']),
    ('24325781000152', 'MD FARMA DISTRIBUIDOR ATACADISTA LTDA', ['mdfarmamg@gmail.com']),
    ('28965704000118', 'MDC DISTRIBUIDORA COMERCIAL LTDA', ['mascarenhasdistribuidora@gmail.com']),
    ('28965704000207', 'MDC DISTRIBUIDORA LTDA', ['expedicao@discombrasil.com.br', 'mascarenhasdistribuidora@gmail.com']),
    ('40222563001110', 'MDP PECAS AUTOMOTIVAS LTDA', ['monaco.dist@gmail.com', 'transporte1@monacodistribuidora.com.br']),
    ('22635177000105', 'MEDCOM LTDA ME', ['logistica@medcom.com.br']),
    ('19288555000109', 'MEGA COMPONENTES LTDA', ['erenciamegabh@hotmail.com']),
    ('05258849000183', 'METAIS SOUZA RESENDE LTDA', ['gerenciadevendas@metaismsr.com.br']),
    ('41397377000103', 'METALAB COMERCIO E INDUSTRIA FARMACEUTICA LTDA', ['Diretoria.financeira@metalabfarma.com.br', 'mirleycomercial@metalabfarma.com.br']),
    ('26770818000691', 'MILLANO DISTRIBUIDORA DE AUTO PECAS', ['expedicao01.bhz@millano.com.br', 'stephany.casagrande@millano.com.br']),
    ('01566501001417', 'MINAS MOTOS LTDA.', ['rit.gaudio@minasmotos.com.br']),
    ('14829830000130', 'MIX PARTS COMERCIO DE PECAS AUTOMOTIVAS LTDA', ['estoque01@mixpartsbrasil.com.br']),
    ('17957932000120', 'MIXTOP DISTRIBUIDORA LTDA - ME', ['ctegrupomixtop@yahoo.com.br', 'mixtopdistribuidora@yahoo.com.br']),
    ('09687036000160', 'MIXVET COMERCIO LTDA EPP', ['mixvet@mixvet.com']),
    ('57398729000509', 'MONTECARLO DISTRIBUIDORA DE AU (C.)', ['nfe-f2@mcol.com.br']),
    ('36047577000520', 'MORELATE SUDESTE DISTRIBUIDORA DE AUTOPE', ['bruno.barbosa@morelate.com.br', 'jaqueline.cesario@morelate.com.br']),
    ('45992220000187', 'MOTO RIO PECAS LTDA', ['motoriopecas@gmail.com']),
    ('29286590000223', 'MOTOVELO DISTRIBUIDORA LTDA', ['comercial01.mg@motovelo.com.br']),
    ('19219732000103', 'MOURAGRO COM DE PROD AGROPEC L (C.)', ['transporte@mouragro.com.br']),
    ('59997459000154', 'MT DISTRIBUIDORA DE EMBALAGENS LTDA', []),
    ('11095340000160', 'MUNDIAL ALTERNADORES IMPORTACAO E DISTRIBUICAO LTDA', ['financeiromundialalternadores2@gmail.com', 'financeiromundialalternadores@gmail.com']),
    ('65304198000142', 'NENA BIKE LTDA (C.)', ['sergio.marques@nenabike.com.br']),
    ('25464260000572', 'NEOBETEL EPI, EQUIPAMENTOS DE PROTECAO INDIVIDUAL LTDA', ['diego.sousa@neobetel.com.br']),
    ('28793964000153', 'NOMAD SPORTS COMERCIO LTDA ME - 022778', ['atendimento@nomadsports.com.br']),
    ('63238082000127', 'NOVA ERA UTILIDADES LTDA', ['lotuscosmeticosmg@gmail.com']),
    ('11069897000479', 'NOVA HOLANDA - TRATORES, IMPLE', ['pousoalegre.adm@nhtratores.com.br']),
    ('06997850000192', 'NUTRENDS LTDA', ['contato@nutrends.com.br']),
    ('71189278000105', 'ORLETTI VEICULOS E PECAS LTDA (C.)', ['eunice.almeida@orvelvw.com.br', 'janderson.anjos@orvelvw.com.br']),
    ('36927534000105', 'PACKFLEX EMBALAGENS FLEXIVEIS LTDA', ['filipe@pollitexpgc.com.br']),
    ('48260594000104', 'PADRAO FORTE INDUSTRIA COMERCI', ['comercial@padraoforte.com.br']),
    ('57102735000143', 'PENNAMED DISTRIBUIDOR ATACADISTA LTDA', ['pennamedmg@gmail.com']),
    ('38603890000107', 'PIONEIRA EQUIPAMENTOS DE SEGUR', ['fernandocdourado@gmail.com', 'pioneiraepicontabilidade@gmail.com']),
    ('07314303000209', 'PMA DISTRIBUIDORA AUTOMOTIVA LTDA - CD', ['contato@pmartins.com.br', 'fiscal@pmartins.com.br']),
    ('02222289000623', 'POLIPECAS DISTRIB.AUT. LTDA (C.)', ['dministrativobhz@polipecas.com.br']),
    ('07699581000140', 'POLLITEX EMBALAGENS FLEXIVEIS EIRELI LTDA', ['contato@pollitexpgc.com.br']),
    ('24330234000165', 'PONTO MAGICO DISTRIBUIDORA LTDA', ['departamentofiscal@lojapontomagico.com.br']),
    ('04896396000158', 'PROVETMINAS PROD VETERINARIOS', ['logistica@vetminas.com.br']),
    ('05841502000169', 'R W R COML LTDA', ['lucas@rwrpecas.com.br', 'marketing@rwrpecas.com.br']),
    ('62454503000194', 'RBM UTILIZADES LTDA', ['lotuscosmeticosmg@gmail.com']),
    ('64267365000160', 'REDE DESENVOLVE VET LTDA', ['diretoriarededesenvolvevet@gmail.com']),
    ('00562583000144', 'RENYLAB QUIMICA E FARMACEUTICA', ['rafael.prado@renylab.ind.br']),
    ('36254750000137', 'RESENDE E SILVA COMERCIO DE SUPLEMENTOS ALIMENTARES EIRELI', ['resendesilvadsa@gmail.com']),
    ('22564053000178', 'RIBEIRO VEICULOS E PECAS LTDA', ['rafael.santos@otobai.com.br']),
    ('46099856000167', 'RIDANA MAKEUP LTDA', ['vendas@ridana.com.br']),
    ('09296836000150', 'RILL COM PECAS FERRAMENTAS ME', ['rodrigo.silveira@rill.com.br']),
    ('61170841000646', 'ROCHESTER DISTRIBUIDORA DE AUT', ['felipe.augusto@rochester.com.br', 'transporte@rochester.com.br']),
    ('61170841000646', 'ROCHESTER DISTRIBUIDORA DE AUT', ['transporte@rochester.com.br']),
    ('12109127000122', 'ROTA CENTRAL DISTRIBUIDORA LTDA ME', ['rotacentral@gmail.com']),
    ('15778354000139', 'RP COMERCIO LTDA - EPP', ['gutierresmeireles@gmail.com']),
    ('08873587000155', 'S & S PECAS AUTOMOTIVAS LTDA', ['transporte@pecamaisautomotive.com.br']),
    ('35663915000404', 'S2BS DISTRIB DE BICICLETAS', ['alana.santos@sensebike.com.br']),
    ('35663915000242', 'S2BS DISTRIBUIDORA DE BICICLET', ['alana.santos@sensebike.com.br']),
    ('68065663000470', 'SAN GROUP BIOTECH BRASIL LTDA', ['sac.sanvet-BR@san-group.com']),
    ('05060037000714', 'SAUVET INDUSTRIA FARMACEUTICA E VETERINARIA LTDA', ['logistica@sauvet.com.br']),
    ('17077640000283', 'SMA DISTRIBUIDORA DE MOTO PECA', ['guilherme.fernandes@nacionalmoto.com.br']),
    ('17077640000364', 'SMA DISTRIBUIDORA DE MOTO PECAS LTDA', ['guilherme.fernandes@nacionalmoto.com.br']),
    ('32463549000370', 'SMAP AUTO PECAS LTDA (C.)', ['cte@smapautopecas.com.br', 'gerencia@smapautopecas.com.br']),
    ('27748346000129', 'SOLUCAO PET DISTRIBUIDORA EIRELI', ['comercial@solucaopetmg.com.br']),
    ('08296100000119', 'SOUSA COM. DE PROD.AUTOMOTIVOS', ['financeiro1.lubrific@gmail.com', 'lubrificminasgerais@gmail.com']),
    ('00110795000190', 'SOVIL DISTRIBUIDORA LTDA.', ['franciely@sovil.com.br']),
    ('61320617000189', 'STR AUTOPARTS SA', ['financeiro@strautoparts.com.br']),
    ('53463613000121', 'TED DISTRIBUIDORA DE PECAS LTDA', ['tdmotosdistribuidora@hotmail.com']),
    ('25296849000185', 'TIDIMAR COM DE PROD MED HOSPIT LTDA EPP', ['almoxarifado2@tidimarhospitalar.com.br']),
    ('03585187000120', 'TOTAL MAXPARTS COMERCIAL LTDA', ['transportes@totalmax.com.br']),
    ('05547064000120', 'TRENAS CIA COMERCIO DE FERRAME', ['faturamento@trenna.com.br']),
    ('65104929000106', 'TURBOTECH DISTRIBUIDORA E COMERCIO DE PRODUTOS AUTOMOTIVOS L', ['financeiro@turbotech.com.br', 'paulo.francisco@turbotechlubrificantes.com.br']),
    ('71336101000186', 'VALE COML LTDA (C.)', ['sac@valecomercial.com.br']),
    ('04771370001406', 'VESPOR AUTOMOTIVE DIST DE AUTO', ['cav@vespor.com.br']),
    ('04771370002399', 'VESPOR AUTOMOTIVE DISTRIB DE AUTO PECAS LTDA', ['cavrib1@vespor.com.br', 'cte@vespor.com.br']),
    ('00376172000164', 'VETOR DISTRIBUIDORA LTDA (C.)( (C.)', ['vetorvet@gmail.com']),
    ('19802033000264', 'VETTS ATACADO VETERINARIO LTDA', ['leonardo.nascimento@pet2pet.com.br']),
    ('18203461000127', 'VIP SPORTS NUTRITION COMERCIO', ['nfe@vipshowroom.com.b']),
    ('37960815000122', 'VIVIANE GONCALVES DE OLIVEIRA', ['mel@sandromotopecas.com.br']),
    ('00922333000178', 'VMC VALVULAS MAQUINAS E CAMARA', ['glaucia@vmconline.com.br']),
    ('08528393000112', 'WB COMPONENTES AUTOMOTIVOS LTDA', ['transporte@wbcomponentes.com.br']),
    ('23840655000173', 'WELTEN COMERCIAL LTDA EPP', ['admwelten@gmail.com']),
]

OPERADORES = {
    "VICTOR": {
        "criar": False,
        "email": "victor.costa@salexpress.com.br",
        "senha": "sal123456",
        "email_relacionamento": "victor.costa@salexpress.com.br",
        "nome_email_outbound": None,
        "segmentos": ["006", "008", "011"],
        "segmento_codigo": None, "segmento_nome": None,
        "dados": DADOS_VICTOR,
    },
    "ISA E KAROL": {
        "criar": True,
        "email": "sac@salexpress.com.br",
        "senha": "sal123456",
        "email_relacionamento": "sac@salexpress.com.br",
        "nome_email_outbound": "Karol e Isabelly",
        "segmentos": ["043"],
        "segmento_codigo": "043", "segmento_nome": "CURVA F",
        "dados": DADOS_ISA_KAROL,
    },
}


def get_operador(nome):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/operadores?nome=eq.{requests.utils.quote(nome)}&select=id,user_id", headers=H, timeout=30)
    r.raise_for_status()
    j = r.json()
    return j[0] if j else None


def find_auth_user(email):
    # admin list users paginado; filtra client-side
    page = 1
    while True:
        r = requests.get(f"{SUPABASE_URL}/auth/v1/admin/users?per_page=200&page={page}", headers=H, timeout=30)
        r.raise_for_status()
        users = r.json().get("users", [])
        if not users:
            return None
        for u in users:
            if (u.get("email") or "").lower() == email.lower():
                return u["id"]
        page += 1
        if page > 50:
            return None


def ensure_auth_user(email, senha):
    r = requests.post(f"{SUPABASE_URL}/auth/v1/admin/users", headers=HJ,
                      data=json.dumps({"email": email, "password": senha, "email_confirm": True}), timeout=30)
    if r.ok:
        return r.json()["id"]
    # ja existe -> busca
    existing = find_auth_user(email)
    if existing:
        print(f"    (auth user ja existia: {email})")
        return existing
    print(f"  X criar auth user {email} falhou: {r.status_code} {r.text[:300]}", file=sys.stderr)
    sys.exit(1)


def montar(dados, seg_cod, seg_nome):
    clientes, contatos, seen = {}, [], set()
    for cnpj, nome, emails in dados:
        if cnpj not in clientes:
            clientes[cnpj] = {"cnpj_cpf": cnpj, "nome": nome,
                              "segmento_codigo": seg_cod, "segmento_nome": seg_nome, "ativo": True}
        for e in emails:
            e = e.strip().lower()
            if "@" not in e or (cnpj, e) in seen:
                continue
            seen.add((cnpj, e))
            contatos.append({"tipo": "email", "identificador": e, "documento_cliente": cnpj,
                             "nome_pessoa": nome, "ativo": True})
    return list(clientes.values()), contatos


def upsert(table, rows, on_conflict=None):
    if not rows:
        return 0
    url = f"{SUPABASE_URL}/rest/v1/{table}" + (f"?on_conflict={on_conflict}" if on_conflict else "")
    h = {**HJ, "Prefer": "resolution=merge-duplicates"}
    n = 0
    for i in range(0, len(rows), 100):
        b = rows[i:i+100]
        r = requests.post(url, headers=h, data=json.dumps(b), timeout=60)
        if not r.ok:
            print(f"  X batch {i} {table}: {r.status_code} {r.text[:300]}", file=sys.stderr); sys.exit(1)
        n += len(b)
    return n


def del_contatos(operador_id):
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/contatos_cliente?operador_responsavel_id=eq.{operador_id}",
                        headers={**H, "Prefer": "return=representation"}, timeout=60)
    r.raise_for_status()
    return len(r.json()) if r.text else 0


def main():
    for nome, cfg in OPERADORES.items():
        print(f"\n===== {nome} =====")
        user_id = ensure_auth_user(cfg["email"], cfg["senha"])
        print(f"  user_id = {user_id}")

        op = get_operador(nome)
        base = {
            "email": cfg["email"], "email_relacionamento": cfg["email_relacionamento"],
            "nome_email_outbound": cfg["nome_email_outbound"], "user_id": user_id,
            "papel": "operador", "ativo": True, "cockpit_ativo": False,
        }
        if op:
            r = requests.patch(f"{SUPABASE_URL}/rest/v1/operadores?nome=eq.{requests.utils.quote(nome)}",
                               headers={**HJ, "Prefer": "return=representation"}, data=json.dumps(base), timeout=30)
            r.raise_for_status()
            operador_id = r.json()[0]["id"]
            print(f"  operadores UPDATE ok ({operador_id})")
        else:
            r = requests.post(f"{SUPABASE_URL}/rest/v1/operadores",
                              headers={**HJ, "Prefer": "return=representation"},
                              data=json.dumps({"nome": nome, "carteira": [], "segmentos": [], **base}), timeout=30)
            r.raise_for_status()
            operador_id = r.json()[0]["id"]
            print(f"  operadores INSERT ok ({operador_id})")

        clientes, contatos = montar(cfg["dados"], cfg["segmento_codigo"], cfg["segmento_nome"])
        for c in contatos:
            c["operador_responsavel_id"] = operador_id
        print(f"  -> {len(clientes)} clientes, {len(contatos)} contatos")
        print(f"  UPSERT clientes: {upsert('clientes', clientes)}")
        print(f"  DELETE contatos antigos: {del_contatos(operador_id)}")
        print(f"  INSERT contatos: {upsert('contatos_cliente', contatos)}")

        cnpjs = sorted({c["cnpj_cpf"] for c in clientes})
        r = requests.patch(f"{SUPABASE_URL}/rest/v1/operadores?nome=eq.{requests.utils.quote(nome)}",
                           headers={**HJ, "Prefer": "return=representation"},
                           data=json.dumps({"carteira": cnpjs, "segmentos": cfg["segmentos"]}), timeout=30)
        r.raise_for_status()
        print(f"  carteira={len(cnpjs)} CNPJs, segmentos={cfg['segmentos']}")

    print("\n* Pronto. cockpit_ativo=FALSE pros 2 - ligar apos validar 1 NF real de cada no SSW.")


if __name__ == "__main__":
    main()
