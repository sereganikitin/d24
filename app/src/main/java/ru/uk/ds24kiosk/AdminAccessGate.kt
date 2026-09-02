package ru.uk.ds24kiosk

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.provider.Settings
import android.text.InputType
import android.widget.EditText
import android.widget.Toast

/**
 * Скрытый доступ для сотрудника УК: держим 3 сек в углу экрана ->
 * диалог с ПИН (BuildConfig.ADMIN_PIN) -> меню обслуживания.
 * Из этого меню, в частности, один раз проходится ручной вход по
 * телефону+SMS от сервисного аккаунта УК — дальше сессия WebView
 * сохраняется между перезапусками приложения.
 */
object AdminAccessGate {

    fun promptPin(activity: Activity, onSuccess: () -> Unit) {
        val input = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = activity.getString(R.string.admin_pin_hint)
        }
        AlertDialog.Builder(activity)
            .setTitle(R.string.admin_pin_title)
            .setView(input)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                if (input.text.toString() == BuildConfig.ADMIN_PIN) {
                    onSuccess()
                } else {
                    Toast.makeText(activity, R.string.admin_pin_wrong, Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    fun showMenu(
        activity: Activity,
        onReload: () -> Unit,
        onResumeKiosk: () -> Unit,
    ) {
        val items = arrayOf(
            activity.getString(R.string.admin_menu_reload),
            activity.getString(R.string.admin_menu_wifi),
            activity.getString(R.string.admin_menu_resume_kiosk),
            activity.getString(R.string.admin_menu_version, BuildConfig.VERSION_NAME),
        )
        // Пункт "Wi-Fi" уводит в системные настройки — на это время киоск
        // остаётся разблокированным (startLockTask() уже снят на момент
        // открытия меню), и снова включится сам при возврате в приложение
        // (MainActivity.onResume). "Обновить" и "Вернуться в киоск-режим"
        // не выходят из активности, поэтому включаем блокировку явно.
        AlertDialog.Builder(activity)
            .setTitle(R.string.admin_menu_title)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> { onReload(); onResumeKiosk() }
                    1 -> activity.startActivity(Intent(Settings.ACTION_WIFI_SETTINGS))
                    2 -> onResumeKiosk()
                    3 -> { /* просто информационный пункт */ }
                }
            }
            .show()
    }
}
