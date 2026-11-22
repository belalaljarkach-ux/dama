-- 006: بيانات تواصل الزبون (اسم التواصل + رقم الهاتف) وبُعد المسافة للمحضر (كم).
-- يُشغَّل يدويًا على قاعدة SQL Server القائمة، ويتطلب أن تكون migration 005 مطبّقة قبله.
-- لا يحذف ولا يعدّل أي بيانات موجودة؛ الأعمدة الجديدة كلها اختيارية (NULL) والسجلات القديمة تبقى كما هي.
-- idempotent: يمكن تشغيله أكثر من مرة دون خطأ.

IF OBJECT_ID('dbo.customers', 'U') IS NULL OR OBJECT_ID('dbo.muhdars', 'U') IS NULL
BEGIN
    RAISERROR(N'طبّق migrations/005-customers-regions-muhdars.sql أولًا.', 16, 1);
    SET NOEXEC ON;
END
GO

IF COL_LENGTH('dbo.customers', 'contact_person') IS NULL
    ALTER TABLE dbo.customers ADD contact_person NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.customers', 'phone') IS NULL
    ALTER TABLE dbo.customers ADD phone NVARCHAR(40) NULL;
GO

-- بُعد المسافة بالكيلومتر (إدخال يدوي، يقبل الكسور). الاختياري في القاعدة؛ التحقق (رقم > 0) في التطبيق.
IF COL_LENGTH('dbo.muhdars', 'distance_km') IS NULL
    ALTER TABLE dbo.muhdars ADD distance_km FLOAT NULL;
GO

SET NOEXEC OFF;
GO

-- تحقق: يجب أن تظهر الأعمدة الثلاثة وكلها NULL-able.
SELECT OBJECT_NAME(c.object_id) AS tbl, c.name, t.name AS type, c.is_nullable
FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE (c.object_id = OBJECT_ID('dbo.customers') AND c.name IN ('contact_person', 'phone'))
   OR (c.object_id = OBJECT_ID('dbo.muhdars') AND c.name = 'distance_km');
GO
