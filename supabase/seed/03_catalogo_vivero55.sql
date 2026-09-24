-- Catálogo de compra de Vivero 55 importado al MODELO CANÓNICO de Nexo (sin tablas paralelas).
-- Añade a Parador Eventos: categorías, proveedores, productos con sus formatos (unidad base ml/g/ud),
-- último precio de compra, mínimos y stock de apertura en el local de prueba «Vivero».
-- Idempotente: los productos que ya existen (mismo nombre o SKU) no se tocan.
-- Requiere 01_parador_eventos.sql. Ejecutar en el SQL Editor de Supabase (Ctrl+A, Run).

drop table if exists tmp_cat;
create temp table tmp_cat (id text, name text, sort int);
insert into tmp_cat values
('champan','Champán',1),('destilados','Destilados (carta)',2),('gamas','Destilados para gamas',3),('vinos','Vinos',4),
('cervezas','Cervezas',5),('refrescos','Refrescos y mixers',6),('energeticas','Energéticas',7),('aguas','Aguas',8),
('zumos','Zumos y siropes',9),('hielo','Hielo',10),('fruta','Fruta y guarnición',11),('snacks','Snacks y picoteo',12),
('consumibles','Consumibles',13);

drop table if exists tmp_sup;
create temp table tmp_sup (code text, name text, tax_id text, contact text, phone text, email text, days text, lead int, min_order numeric);
insert into tmp_sup values
('PRV-DES','Distribuciones Premium Sureste S.L.','B30111111','Javier Martínez','600 111 001','pedidos@premiumsureste.example','lun, jue',2,300),
('PRV-VIN','Vinos y Cavas del Levante S.L.','B03222222','Lucía Sánchez','600 111 002','comercial@vinoslevante.example','mar',3,150),
('PRV-REF','Bebidas Mar Menor S.L.','B30333333','Antonio Ruiz','600 111 003','pedidos@bebidasmarmenor.example','lun, mié, vie',1,120),
('PRV-HIE','Hielos La Manga','B30444444','Paco Hernández','600 111 004','hielo@hieloslamanga.example','todos los días',0,30),
('PRV-FRU','Frutas Hermanos Pérez','B30555555','Rosa Pérez','600 111 005','frutas@hermanosperez.example','lun, mié, vie, sáb',1,40),
('PRV-CER','Cervezas del Sureste Distribución S.L.','B30777777','Manuel López','600 111 007','pedidos@cervezassureste.example','mar, vie',2,150),
('PRV-CAS','Cash Hostelero Levante','B30666666','Mostrador','600 111 006','atencion@cashlevante.example','mar, vie',2,80);

drop table if exists tmp_prod;
create temp table tmp_prod (sku text, name text, cat text, sub text, brand text, fmt text, ml int, unit text, pack_lbl text, pack numeric, cost numeric, vat numeric, sup text, mn numeric, par numeric, gama text, menu text);
insert into tmp_prod values
('CHA-001','Moët & Chandon Brut Impérial','champan','Moët & Chandon','Moët & Chandon','75 cl',750,'botella','Caja 6',6,32.5,21,'PRV-DES',12,24,null,'Moët Brut'),
('CHA-002','Moët & Chandon Ice Impérial','champan','Moët & Chandon','Moët & Chandon','75 cl',750,'botella','Caja 6',6,43.9,21,'PRV-DES',6,18,null,'Moët Ice'),
('CHA-003','Moët & Chandon Ice Impérial Rosé','champan','Moët & Chandon','Moët & Chandon','75 cl',750,'botella','Caja 6',6,48.5,21,'PRV-DES',6,12,null,'Moët Ice Rosé'),
('CHA-004','Moët & Chandon Nectar Impérial Rosé','champan','Moët & Chandon','Moët & Chandon','75 cl',750,'botella','Caja 6',6,52.0,21,'PRV-DES',6,12,null,'Moët N.I.R'),
('CHA-005','Moët & Chandon Brut Impérial Magnum','champan','Moët & Chandon','Moët & Chandon','150 cl',1500,'botella','Unidad',1,76.0,21,'PRV-DES',2,6,null,'Moët Brut Magnum'),
('CHA-006','Moët & Chandon Ice Impérial Magnum','champan','Moët & Chandon','Moët & Chandon','150 cl',1500,'botella','Unidad',1,98.0,21,'PRV-DES',2,4,null,'Moët Ice Magnum'),
('CHA-007','Veuve Clicquot Brut Carte Jaune','champan','Veuve Clicquot','Veuve Clicquot','75 cl',750,'botella','Caja 6',6,36.9,21,'PRV-DES',12,24,null,'Veuve Clicquot'),
('CHA-008','Veuve Clicquot Rosé','champan','Veuve Clicquot','Veuve Clicquot','75 cl',750,'botella','Caja 6',6,45.5,21,'PRV-DES',6,12,null,'Veuve Clicquot Rosé'),
('CHA-009','Veuve Clicquot Rich','champan','Veuve Clicquot','Veuve Clicquot','75 cl',750,'botella','Caja 6',6,49.9,21,'PRV-DES',6,12,null,'Veuve Clicquot Rich'),
('CHA-010','Veuve Clicquot Rich Rosé','champan','Veuve Clicquot','Veuve Clicquot','75 cl',750,'botella','Caja 6',6,55.0,21,'PRV-DES',6,12,null,'Veuve Clicquot Rich Rosé'),
('CHA-011','Ayala Brut Majeur','champan','Ayala','Ayala','75 cl',750,'botella','Caja 6',6,27.8,21,'PRV-DES',6,18,null,'Ayala'),
('CHA-012','Ayala Rosé Majeur','champan','Ayala','Ayala','75 cl',750,'botella','Caja 6',6,34.5,21,'PRV-DES',6,12,null,'Ayala Rosé'),
('CHA-013','Dom Pérignon Vintage 2012','champan','Dom Pérignon','Dom Pérignon','75 cl',750,'botella','Unidad',1,178.0,21,'PRV-DES',2,6,null,'Dom Pérignon Vintage 2012'),
('DES-001','Beluga Noble Magnum','destilados','Vodka','Beluga','175 cl',1750,'botella','Unidad',1,112.0,21,'PRV-DES',1,3,null,'Beluga Magnum'),
('DES-002','Grey Goose Magnum','destilados','Vodka','Grey Goose','175 cl',1750,'botella','Unidad',1,76.5,21,'PRV-DES',1,4,null,'Grey Goose Magnum'),
('DES-003','Grey Goose Jeroboam','destilados','Vodka','Grey Goose','300 cl',3000,'botella','Unidad',1,172.0,21,'PRV-DES',1,2,null,'Grey Goose Jeroboam'),
('DES-004','G''Vine Floraison Magnum','destilados','Ginebra','G''Vine','175 cl',1750,'botella','Unidad',1,71.0,21,'PRV-DES',1,3,null,'G''Vine Magnum'),
('DES-005','Nordés Jeroboam','destilados','Ginebra','Nordés','300 cl',3000,'botella','Unidad',1,108.0,21,'PRV-DES',1,2,null,'Nordés Jeroboam'),
('DES-006','Barceló Imperial Magnum','destilados','Ron','Barceló','175 cl',1750,'botella','Unidad',1,54.0,21,'PRV-DES',1,3,null,'Barceló Imperial Magnum'),
('DES-007','Don Julio Blanco','destilados','Tequila','Don Julio','70 cl',700,'botella','Caja 6',6,37.5,21,'PRV-DES',3,6,null,'Don Julio Silver'),
('DES-008','Don Julio Reposado','destilados','Tequila','Don Julio','70 cl',700,'botella','Caja 6',6,44.9,21,'PRV-DES',2,6,null,'Don Julio Reposado'),
('DES-009','Don Julio 1942','destilados','Tequila','Don Julio','70 cl',700,'botella','Caja 6',6,148.0,21,'PRV-DES',1,3,null,'Don Julio Añejo 1942'),
('DES-010','Patrón Silver','destilados','Tequila','Patrón','70 cl',700,'botella','Caja 6',6,36.8,21,'PRV-DES',3,6,null,'Patrón Silver'),
('DES-011','Patrón Reposado','destilados','Tequila','Patrón','70 cl',700,'botella','Caja 6',6,41.5,21,'PRV-DES',2,6,null,'Patrón Reposado'),
('DES-012','Patrón El Cielo','destilados','Tequila','Patrón','70 cl',700,'botella','Caja 6',6,92.0,21,'PRV-DES',1,3,null,'Patrón El Cielo'),
('DES-013','Patrón El Alto','destilados','Tequila','Patrón','70 cl',700,'botella','Caja 6',6,138.0,21,'PRV-DES',1,2,null,'Patrón Reposado El Alto'),
('DES-014','1800 Guachimontón','destilados','Tequila','1800','70 cl',700,'botella','Caja 6',6,96.0,21,'PRV-DES',1,2,null,'1800 Guachimontón'),
('DES-015','Johnnie Walker Blue Label','destilados','Whisky','Johnnie Walker','70 cl',700,'botella','Caja 6',6,176.0,21,'PRV-DES',1,3,null,'Blue Label'),
('DES-016','Johnnie Walker Gold Label Reserve','destilados','Whisky','Johnnie Walker','70 cl',700,'botella','Caja 6',6,54.5,21,'PRV-DES',2,4,null,'Gold Label'),
('GAM-001','Absolut Blue','gamas','Vodka','Absolut','70 cl',700,'botella','Caja 6',6,11.2,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-002','Beefeater','gamas','Ginebra','Beefeater','70 cl',700,'botella','Caja 6',6,11.5,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-003','Larios 12','gamas','Ginebra','Larios','70 cl',700,'botella','Caja 6',6,10.2,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-004','Bacardí Carta Blanca','gamas','Ron','Bacardí','70 cl',700,'botella','Caja 6',6,10.4,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-005','Brugal Añejo','gamas','Ron','Brugal','70 cl',700,'botella','Caja 6',6,11.8,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-006','Ballantine''s Finest','gamas','Whisky','Ballantine''s','70 cl',700,'botella','Caja 6',6,10.9,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-007','J&B Rare','gamas','Whisky','J&B','70 cl',700,'botella','Caja 6',6,10.8,21,'PRV-DES',6,18,'Básica','Botella Básica'),
('GAM-008','Tanqueray London Dry','gamas','Ginebra','Tanqueray','70 cl',700,'botella','Caja 6',6,15.2,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-009','Bombay Sapphire','gamas','Ginebra','Bombay','70 cl',700,'botella','Caja 6',6,16.4,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-010','Seagram''s','gamas','Ginebra','Seagram''s','70 cl',700,'botella','Caja 6',6,14.6,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-011','Ketel One','gamas','Vodka','Ketel One','70 cl',700,'botella','Caja 6',6,17.3,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-012','Havana Club 7 Años','gamas','Ron','Havana Club','70 cl',700,'botella','Caja 6',6,15.9,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-013','Cacique 500','gamas','Ron','Cacique','70 cl',700,'botella','Caja 6',6,17.5,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-014','Jack Daniel''s Old No. 7','gamas','Whisky','Jack Daniel''s','70 cl',700,'botella','Caja 6',6,17.8,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-015','Johnnie Walker Black Label','gamas','Whisky','Johnnie Walker','70 cl',700,'botella','Caja 6',6,22.5,21,'PRV-DES',4,12,'Premium','Botella Premium'),
('GAM-016','Hendrick''s','gamas','Ginebra','Hendrick''s','70 cl',700,'botella','Caja 6',6,26.5,21,'PRV-DES',3,9,'Ultrapremium','Botella Ultrapremium'),
('GAM-017','Gin Mare','gamas','Ginebra','Gin Mare','70 cl',700,'botella','Caja 6',6,27.2,21,'PRV-DES',3,9,'Ultrapremium','Botella Ultrapremium'),
('GAM-018','Grey Goose','gamas','Vodka','Grey Goose','70 cl',700,'botella','Caja 6',6,28.9,21,'PRV-DES',3,9,'Ultrapremium','Botella Ultrapremium'),
('GAM-019','Belvedere','gamas','Vodka','Belvedere','70 cl',700,'botella','Caja 6',6,27.4,21,'PRV-DES',3,9,'Ultrapremium','Botella Ultrapremium'),
('GAM-020','Brugal 1888','gamas','Ron','Brugal','70 cl',700,'botella','Caja 6',6,27.9,21,'PRV-DES',3,9,'Ultrapremium','Botella Ultrapremium'),
('GAM-021','Diplomático Reserva Exclusiva','gamas','Ron','Diplomático','70 cl',700,'botella','Caja 6',6,29.5,21,'PRV-DES',3,9,'Ultrapremium','Botella Ultrapremium'),
('GAM-022','Ron Zacapa 23','gamas','Ron','Zacapa','70 cl',700,'botella','Caja 6',6,42.5,21,'PRV-DES',1,4,'Reserva','Botella Reserva'),
('GAM-023','Chivas Regal 18','gamas','Whisky','Chivas Regal','70 cl',700,'botella','Caja 6',6,49.8,21,'PRV-DES',1,4,'Reserva','Botella Reserva'),
('GAM-024','The Macallan 12 Double Cask','gamas','Whisky','The Macallan','70 cl',700,'botella','Caja 6',6,56.0,21,'PRV-DES',1,4,'Reserva','Botella Reserva'),
('GAM-025','Monkey 47 (50 cl)','gamas','Ginebra','Monkey 47','50 cl',500,'botella','Caja 6',6,29.8,21,'PRV-DES',1,4,'Reserva','Botella Reserva'),
('VIN-001','Pazo de San Mauro Albariño','vinos','Blancos','Pazo de San Mauro','75 cl · Rías Baixas',750,'botella','Caja 6',6,11.2,21,'PRV-VIN',6,18,null,'Pazo de San Mauro'),
('VIN-002','Juana la Loca Verdejo','vinos','Blancos','Juana la Loca','75 cl · Rueda',750,'botella','Caja 6',6,8.9,21,'PRV-VIN',6,18,null,'Juana la Loca'),
('VIN-003','Juan Gil Blanco Seco','vinos','Blancos','Juan Gil','75 cl · Jumilla',750,'botella','Caja 6',6,6.6,21,'PRV-VIN',6,18,null,'Juan Gil'),
('VIN-004','Chyato Verdejo','vinos','Blancos','Chyato','75 cl · Rueda',750,'botella','Caja 6',6,5.4,21,'PRV-VIN',6,18,null,'Chyato'),
('VIN-005','Boj 570 Albariño','vinos','Blancos','Boj 570','75 cl · Rías Baixas',750,'botella','Caja 6',6,8.3,21,'PRV-VIN',6,18,null,'Boj 570'),
('VIN-006','Pierola Crianza','vinos','Tintos','Pierola','75 cl · Rioja',750,'botella','Caja 6',6,7.6,21,'PRV-VIN',6,18,null,'Pierola'),
('VIN-007','Traslascuestas Roble','vinos','Tintos','Traslascuestas','75 cl · Ribera del Duero',750,'botella','Caja 6',6,6.9,21,'PRV-VIN',6,18,null,'Traslascuestas'),
('VIN-008','Protos 9 Meses','vinos','Tintos','Protos','75 cl · Ribera del Duero',750,'botella','Caja 6',6,8.8,21,'PRV-VIN',6,18,null,'Protos 9 Meses'),
('VIN-009','Cepa 21','vinos','Tintos','Cepa 21','75 cl · Ribera del Duero',750,'botella','Caja 6',6,12.9,21,'PRV-VIN',6,18,null,'Cepa 21'),
('VIN-010','Convento Oreja Crianza','vinos','Tintos','Convento Oreja','75 cl · Ribera del Duero',750,'botella','Caja 6',6,9.7,21,'PRV-VIN',6,18,null,'Convento Oreja Crianza'),
('VIN-011','Muga Rosado','vinos','Rosados','Muga','75 cl · Rioja',750,'botella','Caja 6',6,9.4,21,'PRV-VIN',6,18,null,'Muga'),
('VIN-012','Lalomba Rosado','vinos','Rosados','Lalomba','75 cl · Rioja',750,'botella','Caja 6',6,15.8,21,'PRV-VIN',6,18,null,'Lalomba'),
('REF-001','Coca-Cola','refrescos','Coca-Cola','Coca-Cola','Vidrio 20 cl',200,'unidad','Caja 24',24,0.54,21,'PRV-REF',48,144,null,null),
('REF-002','Coca-Cola Zero','refrescos','Coca-Cola','Coca-Cola','Vidrio 20 cl',200,'unidad','Caja 24',24,0.54,21,'PRV-REF',48,144,null,null),
('REF-003','Coca-Cola Zero Zero','refrescos','Coca-Cola','Coca-Cola','Vidrio 20 cl',200,'unidad','Caja 24',24,0.56,21,'PRV-REF',24,72,null,null),
('REF-004','Fanta Limón','refrescos','Fanta','Fanta','Vidrio 20 cl',200,'unidad','Caja 24',24,0.49,21,'PRV-REF',24,72,null,null),
('REF-005','Fanta Naranja','refrescos','Fanta','Fanta','Vidrio 20 cl',200,'unidad','Caja 24',24,0.49,21,'PRV-REF',24,72,null,null),
('REF-006','Sprite','refrescos','Sprite','Sprite','Vidrio 20 cl',200,'unidad','Caja 24',24,0.49,21,'PRV-REF',24,48,null,null),
('REF-007','Nestea Limón','refrescos','Té frío','Nestea','Lata 33 cl',330,'unidad','Caja 24',24,0.62,21,'PRV-REF',24,48,null,null),
('REF-008','Royal Bliss Tónica','refrescos','Tónicas','Royal Bliss','Vidrio 20 cl',200,'unidad','Caja 24',24,0.63,21,'PRV-REF',48,144,null,null),
('REF-009','Royal Bliss Berry Sensation','refrescos','Tónicas','Royal Bliss','Vidrio 20 cl',200,'unidad','Caja 24',24,0.69,21,'PRV-REF',24,72,null,null),
('REF-010','Royal Bliss Ginger Ale','refrescos','Tónicas','Royal Bliss','Vidrio 20 cl',200,'unidad','Caja 24',24,0.66,21,'PRV-REF',24,48,null,null),
('REF-011','Schweppes Tónica','refrescos','Tónicas','Schweppes','Vidrio 25 cl',250,'unidad','Caja 24',24,0.58,21,'PRV-REF',24,48,null,null),
('REF-012','Schweppes Limón','refrescos','Schweppes','Schweppes','Vidrio 25 cl',250,'unidad','Caja 24',24,0.58,21,'PRV-REF',24,48,null,null),
('REF-013','Aquarius Limón','refrescos','Isotónicas','Aquarius','Lata 33 cl',330,'unidad','Caja 24',24,0.66,21,'PRV-REF',24,48,null,null),
('ENE-001','Red Bull Energy Drink','energeticas','Red Bull','Red Bull','Lata 25 cl',250,'unidad','Bandeja 24',24,1.12,21,'PRV-REF',48,168,null,null),
('ENE-002','Red Bull Sugarfree','energeticas','Red Bull','Red Bull','Lata 25 cl',250,'unidad','Bandeja 24',24,1.12,21,'PRV-REF',24,72,null,null),
('ENE-003','Red Bull Red Edition (Sandía)','energeticas','Red Bull','Red Bull','Lata 25 cl',250,'unidad','Bandeja 24',24,1.18,21,'PRV-REF',24,48,null,null),
('ENE-004','Red Bull Tropical Edition','energeticas','Red Bull','Red Bull','Lata 25 cl',250,'unidad','Bandeja 24',24,1.18,21,'PRV-REF',24,48,null,null),
('AGU-001','Agua mineral natural 50 cl','aguas','Sin gas','Font Vella','PET 50 cl',500,'unidad','Pack 24',24,0.21,10,'PRV-REF',48,144,null,null),
('AGU-002','Solán de Cabras vidrio 1 L','aguas','Sin gas','Solán de Cabras','Vidrio 1 L',1000,'unidad','Caja 12',12,0.95,10,'PRV-REF',12,48,null,null),
('AGU-003','Vichy Catalán 30 cl','aguas','Con gas','Vichy Catalán','Vidrio 30 cl',300,'unidad','Caja 24',24,0.62,10,'PRV-REF',24,48,null,null),
('ZUM-001','Zumo de piña 1 L','zumos','Zumos','Don Simón','Brik 1 L',1000,'unidad','Caja 6',6,1.65,10,'PRV-REF',6,18,null,null),
('ZUM-002','Zumo de naranja 1 L','zumos','Zumos','Don Simón','Brik 1 L',1000,'unidad','Caja 6',6,1.55,10,'PRV-REF',6,18,null,null),
('ZUM-003','Zumo de arándano rojo 1 L','zumos','Zumos','Ocean Spray','Botella 1 L',1000,'unidad','Caja 6',6,2.4,10,'PRV-REF',3,12,null,null),
('ZUM-004','Sirope de granadina 1 L','zumos','Siropes','Monin','Botella 1 L',1000,'unidad','Unidad',1,6.8,21,'PRV-CAS',1,3,null,null),
('HIE-001','Hielo cubito macizo 2 kg','hielo','Cubito','Hielos La Manga','Bolsa 2 kg',null,'bolsa','Unidad',1,1.1,10,'PRV-HIE',40,120,null,null),
('HIE-002','Hielo picado 2 kg','hielo','Picado','Hielos La Manga','Bolsa 2 kg',null,'bolsa','Unidad',1,1.25,10,'PRV-HIE',10,30,null,null),
('HIE-003','Hielo cubito macizo 10 kg','hielo','Cubito','Hielos La Manga','Saco 10 kg',null,'saco','Unidad',1,4.2,10,'PRV-HIE',5,15,null,null),
('FRU-001','Limones','fruta','Cítricos',null,'Kg',null,'kg','Kg',1,1.85,4,'PRV-FRU',3,8,null,null),
('FRU-002','Limas','fruta','Cítricos',null,'Kg',null,'kg','Kg',1,3.4,4,'PRV-FRU',2,6,null,null),
('FRU-003','Naranjas','fruta','Cítricos',null,'Kg',null,'kg','Kg',1,1.35,4,'PRV-FRU',2,6,null,null),
('FRU-004','Pomelo','fruta','Cítricos',null,'Kg',null,'kg','Kg',1,2.1,4,'PRV-FRU',1,3,null,null),
('FRU-005','Fresas bandeja 500 g','fruta','Frutos rojos',null,'Bandeja',null,'bandeja','Bandeja',1,2.9,4,'PRV-FRU',4,12,null,null),
('FRU-006','Frambuesas 125 g','fruta','Frutos rojos',null,'Tarrina',null,'tarrina','Tarrina',1,2.3,4,'PRV-FRU',4,10,null,null),
('FRU-007','Arándanos 125 g','fruta','Frutos rojos',null,'Tarrina',null,'tarrina','Tarrina',1,2.1,4,'PRV-FRU',4,10,null,null),
('FRU-008','Piña','fruta','Bandejas de fruta',null,'Unidad',null,'unidad','Unidad',1,1.9,4,'PRV-FRU',3,8,null,null),
('FRU-009','Sandía','fruta','Bandejas de fruta',null,'Kg',null,'kg','Kg',1,0.85,4,'PRV-FRU',5,15,null,null),
('FRU-010','Uva blanca sin pepita','fruta','Bandejas de fruta',null,'Kg',null,'kg','Kg',1,3.2,4,'PRV-FRU',2,5,null,null),
('FRU-011','Mango','fruta','Bandejas de fruta',null,'Unidad',null,'unidad','Unidad',1,1.6,4,'PRV-FRU',3,8,null,null),
('FRU-012','Pepino','fruta','Guarnición',null,'Kg',null,'kg','Kg',1,1.1,4,'PRV-FRU',1,3,null,null),
('FRU-013','Hierbabuena','fruta','Guarnición',null,'Manojo',null,'manojo','Manojo',1,0.95,4,'PRV-FRU',3,8,null,null),
('FRU-014','Sal en escamas 250 g','fruta','Guarnición',null,'Unidad',null,'unidad','Unidad',1,3.2,10,'PRV-CAS',1,3,null,null),
('SNA-001','Frutos secos cóctel 1 kg','snacks','Frutos secos',null,'Bolsa',null,'bolsa','Bolsa',1,9.8,10,'PRV-CAS',2,5,null,null),
('SNA-002','Pistachos tostados 1 kg','snacks','Frutos secos',null,'Bolsa',null,'bolsa','Bolsa',1,14.5,10,'PRV-CAS',1,3,null,null),
('SNA-003','Kikos 1 kg','snacks','Frutos secos',null,'Bolsa',null,'bolsa','Bolsa',1,4.1,10,'PRV-CAS',1,4,null,null),
('SNA-004','Patatas chips hostelería 500 g','snacks','Salados',null,'Bolsa',null,'bolsa','Bolsa',1,3.4,10,'PRV-CAS',3,8,null,null),
('SNA-005','Gominolas surtidas 1 kg','snacks','Dulces',null,'Bolsa',null,'bolsa','Bolsa',1,6.2,10,'PRV-CAS',2,6,null,null),
('SNA-006','Chocolatinas surtidas (caja 50)','snacks','Dulces',null,'Caja',null,'caja','Caja',1,11.5,10,'PRV-CAS',1,2,null,null),
('CON-001','Bengalas para botella (caja 60)','consumibles','Bottle service',null,'Caja 60',null,'unidad','Caja 60',60,0.42,21,'PRV-CAS',60,240,null,null),
('CON-002','Pajitas de papel negras (caja 250)','consumibles','Barra',null,'Caja 250',null,'caja','Unidad',1,4.8,21,'PRV-CAS',2,6,null,null),
('CON-003','Servilletas cóctel negras 20x20 (paq. 100)','consumibles','Barra',null,'Paquete 100',null,'paquete','Unidad',1,1.6,21,'PRV-CAS',5,15,null,null),
('CON-004','Palillos de cóctel (caja 1000)','consumibles','Barra',null,'Caja 1000',null,'caja','Unidad',1,3.2,21,'PRV-CAS',1,3,null,null),
('CON-005','Vasos de tubo desechables 30 cl (paq. 50)','consumibles','Barra',null,'Paquete 50',null,'paquete','Unidad',1,5.9,21,'PRV-CAS',4,12,null,null),
('CER-001','Heineken barril 30 L','cervezas','Barril','Heineken','Barril 30 L',30000,'barril','Unidad',1,96.0,21,'PRV-CER',2,6,null,null),
('CER-002','Paulaner Hefe-Weißbier barril 30 L','cervezas','Barril','Paulaner','Barril 30 L',30000,'barril','Unidad',1,128.0,21,'PRV-CER',1,4,null,null),
('CER-003','Heineken tercio 33 cl','cervezas','Tercio','Heineken','Vidrio 33 cl',330,'unidad','Caja 24',24,0.78,21,'PRV-CER',48,144,null,null),
('CER-004','El Águila Sin Filtrar tercio 33 cl','cervezas','Tercio','El Águila','Vidrio 33 cl',330,'unidad','Caja 24',24,0.74,21,'PRV-CER',24,96,null,null);

-- Stock de referencia del local (se carga como apertura en el local de prueba «Vivero»).
drop table if exists tmp_stock;
create temp table tmp_stock (sku text, qty numeric);
insert into tmp_stock values
('CHA-001',11),('CHA-002',14),('CHA-003',13),('CHA-004',2),('CHA-005',4),('CHA-006',4),('CHA-007',7),('CHA-008',7),('CHA-009',12),
('CHA-010',1),('CHA-011',8),('CHA-012',10),('CHA-013',6),('DES-001',1),('DES-002',3),('DES-003',2),('DES-004',1),('DES-005',1),
('DES-006',3),('DES-007',1),('DES-008',3),('DES-009',2),('DES-010',6),('DES-011',1),('DES-012',2),('DES-013',2),('DES-014',1),
('DES-015',2),('DES-016',4),('GAM-001',2),('GAM-002',8),('GAM-003',14),('GAM-004',19),('GAM-005',4),('GAM-006',12),('GAM-007',17),
('GAM-008',4),('GAM-009',7),('GAM-010',12),('GAM-011',1),('GAM-012',5),('GAM-013',10),('GAM-014',13),('GAM-015',2),('GAM-016',6),
('GAM-017',9),('GAM-018',3),('GAM-019',5),('GAM-020',9),('GAM-021',1),('GAM-022',2),('GAM-023',3),('GAM-024',4),('GAM-025',1),
('VIN-001',12),('VIN-002',17),('VIN-003',5),('VIN-004',10),('VIN-005',18),('VIN-006',2),('VIN-007',8),('VIN-008',14),('VIN-009',19),
('VIN-010',4),('VIN-011',12),('VIN-012',17),('REF-001',43),('REF-002',79),('REF-003',72),('REF-004',7),('REF-005',32),('REF-006',38),
('REF-007',50),('REF-008',29),('REF-009',47),('REF-010',46),('REF-011',14),('REF-012',26),('REF-013',48),('ENE-001',17),('ENE-002',32),
('ENE-003',38),('ENE-004',50),('AGU-001',29),('AGU-002',31),('AGU-003',46),('ZUM-001',5),('ZUM-002',10),('ZUM-003',12),('ZUM-004',0),
('HIE-001',54),('HIE-002',24),('HIE-003',16),('FRU-001',1.6),('FRU-002',3.9),('FRU-003',5.7),('FRU-004',0.9),('FRU-005',7),('FRU-006',10),
('FRU-007',1),('FRU-008',4),('FRU-009',12.0),('FRU-010',5.2),('FRU-011',2),('FRU-012',2.0),('FRU-013',8),('FRU-014',1),('SNA-001',3),
('SNA-002',3),('SNA-003',0),('SNA-004',4),('SNA-005',5),('SNA-006',2),('CON-001',48),('CON-002',4),('CON-003',14),('CON-004',1),
('CON-005',7),('CER-001',6),('CER-002',0),('CER-003',65),('CER-004',77);

do $$
declare
  v_org uuid;
  v_vivero uuid;
  r record;
  v_product uuid;
  v_dimension unit_dimension;
  v_factor numeric;       -- unidad de compra/base del catálogo → unidad base de Nexo (ml, g, ud)
  v_count_pack uuid;
  v_purchase_pack uuid;
  v_supplier uuid;
  v_stock numeric;
begin
  select id into v_org from organizations where name = 'Parador Eventos' limit 1;
  if v_org is null then
    raise exception 'Organización no encontrada. Ejecuta primero 01_parador_eventos.sql.';
  end if;
  select id into v_vivero from locations where org_id = v_org and name = 'Vivero' limit 1;

  insert into categories (org_id, name, sort_order)
  select v_org, c.name, 100 + c.sort from tmp_cat c
  on conflict do nothing;

  insert into suppliers (org_id, name, tax_id, email, phone, notes)
  select v_org, s.name, s.tax_id, s.email, s.phone,
         format('Contacto: %s · Reparto: %s · Plazo: %s días · Pedido mínimo: %s €', s.contact, s.days, s.lead, s.min_order)
  from tmp_sup s
  on conflict do nothing;

  for r in select p.*, c.name as cat_name, s.name as sup_name from tmp_prod p join tmp_cat c on c.id = p.cat join tmp_sup s on s.code = p.sup loop
    -- Bebidas por botella o barril se miden en ml; fruta a granel en g; el resto en unidades.
    if r.unit = 'kg' then
      v_dimension := 'mass'; v_factor := 1000;
    elsif r.ml is not null and r.unit in ('botella', 'barril') then
      v_dimension := 'volume'; v_factor := r.ml;
    else
      v_dimension := 'count'; v_factor := 1;
    end if;

    insert into products (org_id, category_id, name, dimension, sku, notes)
    values (
      v_org,
      (select id from categories where org_id = v_org and name = r.cat_name and parent_id is null limit 1),
      r.name, v_dimension, r.sku,
      concat_ws(' · ', nullif(r.brand, ''), r.sub, r.fmt, case when r.gama is not null then 'Gama ' || r.gama end, case when r.menu is not null then 'Carta: ' || r.menu end, 'IVA ' || r.vat || ' %')
    )
    on conflict do nothing
    returning id into v_product;

    continue when v_product is null;  -- ya existía: no se toca

    -- Formato de conteo (la botella, el barril o el kg) y formato de compra (caja, bandeja…).
    v_count_pack := null;
    if v_dimension = 'volume' then
      insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
      values (v_product, case when r.unit = 'barril' then split_part(r.fmt, ' ·', 1) else 'Botella ' || split_part(r.fmt, ' ·', 1) end, v_factor, true, r.pack = 1)
      returning id into v_count_pack;
    elsif v_dimension = 'mass' then
      insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
      values (v_product, 'Kg', 1000, true, r.pack = 1)
      returning id into v_count_pack;
    end if;

    if r.pack > 1 then
      insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
      values (v_product, r.pack_lbl, r.pack * v_factor, false, true)
      returning id into v_purchase_pack;
    elsif v_count_pack is not null then
      v_purchase_pack := v_count_pack;
    else
      insert into product_packs (product_id, name, qty_base, is_count_default, is_purchase_default)
      values (v_product, initcap(split_part(r.fmt, ' ', 1)), 1, false, true)
      returning id into v_purchase_pack;
    end if;

    -- Último precio de compra del formato de compra.
    select id into v_supplier from suppliers where org_id = v_org and name = r.sup_name limit 1;
    insert into supplier_prices (supplier_id, pack_id, last_price, last_price_at)
    values (v_supplier, v_purchase_pack, round(r.cost * r.pack, 4), now())
    on conflict do nothing;

    if v_vivero is not null then
      insert into location_products (location_id, product_id, min_qty, par_qty)
      values (v_vivero, v_product, r.mn * v_factor, r.par * v_factor)
      on conflict do nothing;

      select qty into v_stock from tmp_stock where sku = r.sku;
      if coalesce(v_stock, 0) > 0 then
        -- El stock solo cambia con movimientos: apertura inmutable (el trigger calcula el saldo).
        insert into stock_movements (org_id, location_id, product_id, type, qty, unit_cost, reason)
        values (v_org, v_vivero, v_product, 'opening', v_stock * v_factor, round(r.cost / v_factor, 6), 'Apertura: catálogo Vivero 55');
      end if;
    end if;
  end loop;
end $$;

drop table if exists tmp_cat, tmp_sup, tmp_prod, tmp_stock;
