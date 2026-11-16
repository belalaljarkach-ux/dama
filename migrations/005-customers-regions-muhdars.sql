-- 005: الزبائن والمناطق والمحاضر + ربط سجلات الخروج بالمحضر + ملء قوائم الزبائن والسائقين من السجلات السابقة.
-- يُشغَّل يدويًا على قاعدة SQL Server القائمة. لا يحذف ولا يعدّل أي سجل خروج قائم
-- (يضيف عمودًا فارغًا muhdar_id فقط، ويُنشئ جداول جديدة، ويُضيف صفوفًا جديدة إلى قوائم الزبائن والسائقين).
-- idempotent: يمكن تشغيله أكثر من مرة دون خطأ أو تكرار.
--
-- قبل تشغيله: النظام يعمل كما كان (اسم الزبون يُكتب حرًّا، ولا يظهر قسم المحاضر).
-- بعد تشغيله (يُلتقط خلال ~30 ثانية دون إعادة تشغيل): قوائم الزبائن والسائقين اختيار فقط،
-- والمحضر إلزامي عند تسجيل خروج آلية، وتُدار الزبائن والمناطق والمحاضر من «الإعداد الأولي».
--
-- ملاحظة: اختيار السائق من القائمة يُفرض في الخادم دون انتظار هذا الملف (جدول drivers موجود أصلًا).
-- القسم (4) يُضيف إلى جدول drivers كل سائق ظهر في السجلات السابقة ولم يُسجَّل بعد،
-- كي لا يتعطل تسجيل الخروج لسائقين اعتادوا العمل قبل هذا التعديل.

-- (1) الزبائن
IF OBJECT_ID('dbo.customers', 'U') IS NULL
    CREATE TABLE dbo.customers (
        id         NVARCHAR(64)  NOT NULL PRIMARY KEY,
        name       NVARCHAR(200) NOT NULL,
        created_at NVARCHAR(40)  NOT NULL
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_customers_name' AND object_id = OBJECT_ID('dbo.customers'))
    CREATE UNIQUE INDEX ux_customers_name ON dbo.customers(name);
GO

-- (2) المناطق
IF OBJECT_ID('dbo.regions', 'U') IS NULL
    CREATE TABLE dbo.regions (
        id         NVARCHAR(64)  NOT NULL PRIMARY KEY,
        name       NVARCHAR(200) NOT NULL,
        created_at NVARCHAR(40)  NOT NULL
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_regions_name' AND object_id = OBJECT_ID('dbo.regions'))
    CREATE UNIQUE INDEX ux_regions_name ON dbo.regions(name);
GO

-- (3) المحاضر: كل محضر مرتبط بزبون واحد ومنطقة واحدة (علاقتان بمفتاح أجنبي)
IF OBJECT_ID('dbo.muhdars', 'U') IS NULL
    CREATE TABLE dbo.muhdars (
        id          NVARCHAR(64)  NOT NULL PRIMARY KEY,
        name        NVARCHAR(200) NOT NULL,
        customer_id NVARCHAR(64)  NOT NULL CONSTRAINT fk_muhdars_customer FOREIGN KEY REFERENCES dbo.customers(id),
        region_id   NVARCHAR(64)  NOT NULL CONSTRAINT fk_muhdars_region   FOREIGN KEY REFERENCES dbo.regions(id),
        created_at  NVARCHAR(40)  NOT NULL
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ux_muhdars_name' AND object_id = OBJECT_ID('dbo.muhdars'))
    CREATE UNIQUE INDEX ux_muhdars_name ON dbo.muhdars(name);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_muhdars_customer' AND object_id = OBJECT_ID('dbo.muhdars'))
    CREATE INDEX ix_muhdars_customer ON dbo.muhdars(customer_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_muhdars_region' AND object_id = OBJECT_ID('dbo.muhdars'))
    CREATE INDEX ix_muhdars_region ON dbo.muhdars(region_id);
GO

-- ربط سجل الخروج بالمحضر (عمود اختياري؛ السجلات القديمة تبقى فارغة ولا تتغير)
IF COL_LENGTH('dbo.entries', 'muhdar_id') IS NULL
    ALTER TABLE dbo.entries ADD muhdar_id NVARCHAR(64) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'ix_entries_muhdar' AND object_id = OBJECT_ID('dbo.entries'))
    CREATE INDEX ix_entries_muhdar ON dbo.entries(muhdar_id);
GO

-- (4) ملء القوائم من السجلات السابقة (إضافة صفوف جديدة فقط، بعد تنظيف المسافات وإزالة التكرار)
INSERT INTO dbo.customers (id, name, created_at)
SELECT N'c' + LOWER(CONVERT(NVARCHAR(36), NEWID())), s.name, CONVERT(NVARCHAR(40), SYSUTCDATETIME(), 127)
FROM (SELECT DISTINCT LTRIM(RTRIM(customer)) AS name FROM dbo.entries
      WHERE customer IS NOT NULL AND LTRIM(RTRIM(customer)) <> N'') s
WHERE NOT EXISTS (SELECT 1 FROM dbo.customers c WHERE c.name = s.name);
GO

INSERT INTO dbo.drivers (id, name, created_at)
SELECT N'd' + LOWER(CONVERT(NVARCHAR(36), NEWID())), s.name, CONVERT(NVARCHAR(40), SYSUTCDATETIME(), 127)
FROM (SELECT DISTINCT LTRIM(RTRIM(driver)) AS name FROM dbo.entries
      WHERE driver IS NOT NULL AND LTRIM(RTRIM(driver)) <> N'') s
WHERE NOT EXISTS (SELECT 1 FROM dbo.drivers d WHERE d.name = s.name);
GO

-- تحقق: الجداول والعمود موجودة وعدد الصفوف المُلئت.
SELECT
    (SELECT COUNT(*) FROM dbo.customers) AS customers_count,
    (SELECT COUNT(*) FROM dbo.regions)   AS regions_count,
    (SELECT COUNT(*) FROM dbo.muhdars)   AS muhdars_count,
    (SELECT COUNT(*) FROM dbo.drivers)   AS drivers_count,
    CASE WHEN COL_LENGTH('dbo.entries', 'muhdar_id') IS NULL THEN 0 ELSE 1 END AS entries_muhdar_id_exists;
