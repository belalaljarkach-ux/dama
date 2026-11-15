-- 004: إضافة عمود طول المضخة (بالمتر) لجدول الآليات.
-- يُشغَّل يدويًا على قاعدة SQL Server القائمة. لا يحذف ولا يعدّل أي بيانات موجودة.
-- idempotent: يمكن تشغيله أكثر من مرة دون خطأ.
-- العمود اختياري (NULL) في القاعدة؛ إلزامية الإدخال عند نوع «مضخة» تُفرض في التطبيق.

IF COL_LENGTH('dbo.vehicles', 'pump_length_m') IS NULL
    ALTER TABLE dbo.vehicles ADD pump_length_m FLOAT NULL;
GO

-- تحقق: يجب أن يظهر العمود pump_length_m بنوع float وقابل لـ NULL.
SELECT c.name, t.name AS type, c.is_nullable
FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('dbo.vehicles') AND c.name = 'pump_length_m';
