#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_system.h"
#include "protocol.h"
#include "clk.h"
#include "flash_driver.h"
#include "scheduler.h"
#include "dispatch.h"
#include "transport_wifi.h"
#include "transport_ble.h"
#include "config_store.h"
#include "nvs_flash.h"

static const char *TAG = "main";

#define PIN_STATUS_LED 2
#define PIN_MODE_BTN   0     /* the onboard BOOT button; no extra parts needed */
#define MODE_HOLD_MS   2000

void app_main(void)
{
    ESP_LOGI(TAG, "SmartCam flash unit booting, fw_ver=0x01");

    gpio_config_t led_io = {
        .pin_bit_mask = 1ULL << PIN_STATUS_LED,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&led_io));

    /* GPIO0 is the BOOT button: active-low, pulled up on the board. Reusing it
       avoids adding any external part. */
    gpio_config_t btn_io = {
        .pin_bit_mask = 1ULL << PIN_MODE_BTN,
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&btn_io));

    clk_init();
    flash_init();
    sched_init();

    bool ok = true;
    ok &= proto_selftest_run();
    ok &= clk_selftest_run();
    ok &= flash_selftest_run();
    ok &= sched_selftest_run();
    ok &= dispatch_selftest_run();

    /* Transport comes up only after the self-tests, because dispatch_selftest_run
       installs its own capture callback and would otherwise clobber the real one. */
    esp_err_t nvs = nvs_flash_init();
    if (nvs == ESP_ERR_NVS_NO_FREE_PAGES || nvs == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvs = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvs);
    cfg_init();

    /* One radio at a time, deliberately: BLE and WiFi share a single radio on the
       ESP32, and running both would time-slice it — degrading each transport and
       making the latency comparison unattributable. */
    uint8_t mode = cfg_mode();
    dispatch_set_mode(mode);
    if (mode == CFG_MODE_BLE) {
        dispatch_init(ble_transport_send);
        ble_transport_start();
    } else {
        dispatch_init(wifi_transport_send);
        wifi_transport_start();
    }

    /* Slow blink = BLE, fast = WiFi, so the active radio is readable from across
       the bench without a serial monitor. A failed self-test blinks fastest of
       all, so a bad build is obvious too. */
    int blink_ms = !ok ? 60 : (mode == CFG_MODE_BLE ? 500 : 150);
    int held_ms  = 0;

    ESP_LOGI(TAG, "ready in %s mode - hold BOOT %d s to switch",
             mode == CFG_MODE_BLE ? "BLE" : "WiFi", MODE_HOLD_MS / 1000);

    while (1) {
        gpio_set_level(PIN_STATUS_LED, 1);
        vTaskDelay(pdMS_TO_TICKS(blink_ms));
        gpio_set_level(PIN_STATUS_LED, 0);
        vTaskDelay(pdMS_TO_TICKS(blink_ms));

        if (gpio_get_level(PIN_MODE_BTN) == 0) {
            held_ms += blink_ms * 2;
            if (held_ms >= MODE_HOLD_MS) {
                uint8_t next = (cfg_mode() == CFG_MODE_BLE) ? CFG_MODE_WIFI
                                                            : CFG_MODE_BLE;
                ESP_LOGI(TAG, "mode switch -> %s, restarting",
                         next == CFG_MODE_BLE ? "BLE" : "WiFi");
                cfg_set_mode(next);
                vTaskDelay(pdMS_TO_TICKS(100));
                esp_restart();
            }
        } else {
            held_ms = 0;
        }
    }
}
