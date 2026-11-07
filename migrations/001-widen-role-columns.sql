-- ============================================================================
-- Migration 001 — توسيع عمودَي الدور في SQL Server (sessions.role و audit.role)
--
-- السبب: أسماء الأدوار fuel_warehouse_manager (22 حرفًا) والدور الجديد
-- fleet_coordinator (17 حرفًا) أطول من عرض العمودين القديم NVARCHAR(16)، فيُقصّ
-- اسم الدور في الجلسة أو يفشل الإدخال، ولا يعمل الحساب. جدول users.role عرضه 32
-- أصلًا فلا يحتاج تعديلًا.
--
-- الأثر: توسيع فقط — لا تُحذف ولا تُعدَّل أي بيانات، ولا علاقة للتغيير بجداول
-- العمليات (entries) أو المازوت أو الآليات. آمن للتشغيل أكثر من مرة (idempotent).
--
-- ملاحظة: التطبيق ينفّذ الخطوة نفسها تلقائيًا عند الإقلاع (widenRoleColumns في
-- db-mssql.js)؛ هذا الملف للتشغيل اليدوي بحساب يملك ALTER إن لم يملكها حساب التطبيق.
-- المحرّكان SQLite وMongoDB بلا حدود لطول النص فلا يحتاجان أي migration.
--
-- التشغيل (SSMS أو sqlcmd) على قاعدة gate_log:
--   sqlcmd -S <server> -d gate_log -i migrations\001-widen-role-columns.sql
-- ============================================================================

IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('dbo.sessions') AND name = 'role' AND max_length < 64)
    ALTER TABLE dbo.sessions ALTER COLUMN role NVARCHAR(32) NOT NULL;

IF EXISTS (SELECT 1 FROM sys.columns
           WHERE object_id = OBJECT_ID('dbo.audit') AND name = 'role' AND max_length < 64)
    ALTER TABLE dbo.audit ALTER COLUMN role NVARCHAR(32) NOT NULL;

-- تحقّق (يجب أن يُرجع max_length = 64 بالبايت = 32 حرفًا لكلا الصفين):
SELECT OBJECT_NAME(object_id) AS table_name, name, max_length / 2 AS chars
FROM sys.columns
WHERE name = 'role' AND object_id IN (OBJECT_ID('dbo.sessions'), OBJECT_ID('dbo.audit'), OBJECT_ID('dbo.users'));
