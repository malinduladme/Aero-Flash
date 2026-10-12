# esp_driver_gpio is explicit because ESP-IDF v5.5 split the old monolithic
# "driver" component into esp_driver_* pieces, and naming any REQUIRES at all
# drops the implicit dependency main would otherwise inherit.
idf_component_register(SRCS "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES protocol clk flash_driver scheduler dispatch
                                transport_wifi transport_ble config_store
                                nvs_flash esp_system esp_driver_gpio)
