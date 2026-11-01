-- BenchPoll schema only. No production rows or credentials.
-- Import ONLY into a NEW EMPTY development database, never production.
-- Includes views, stored routines and triggers. Review DEFINER privileges before importing.
-- Exported 2026-11-01T07:09:18.646Z

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `aa_data_archive_items` (
  `batch_id` varchar(64) NOT NULL,
  `entity_type` varchar(32) NOT NULL,
  `object_id` bigint unsigned NOT NULL,
  `related_id` bigint unsigned NOT NULL DEFAULT '0',
  `extra_id` bigint unsigned NOT NULL DEFAULT '0',
  `original_state` json NOT NULL,
  `reason` varchar(64) NOT NULL,
  `restored_at` datetime DEFAULT NULL,
  PRIMARY KEY (`batch_id`,`entity_type`,`object_id`,`related_id`,`extra_id`),
  CONSTRAINT `fk_aa_archive_batch` FOREIGN KEY (`batch_id`) REFERENCES `aa_data_archive_runs` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `aa_data_archive_runs` (
  `batch_id` varchar(64) NOT NULL,
  `backup_path` varchar(512) NOT NULL,
  `benchmark_count` int unsigned NOT NULL,
  `condition_count` int unsigned NOT NULL,
  `result_count` int unsigned NOT NULL,
  `archived_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_message_reads` (
  `message_ID` bigint unsigned NOT NULL,
  `user_ID` bigint unsigned NOT NULL,
  `read_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`message_ID`,`user_ID`),
  KEY `idx_admin_message_reads_user` (`user_ID`,`read_at`),
  CONSTRAINT `fk_admin_message_reads_message` FOREIGN KEY (`message_ID`) REFERENCES `admin_messages` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_message_reads_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `admin_messages` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `sender_user_ID` bigint unsigned NOT NULL,
  `recipient_scope` enum('senior') NOT NULL DEFAULT 'senior',
  `body` text NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  KEY `idx_admin_messages_created` (`created_at`),
  KEY `idx_admin_messages_sender_created` (`sender_user_ID`,`created_at`),
  CONSTRAINT `fk_admin_messages_sender_user` FOREIGN KEY (`sender_user_ID`) REFERENCES `users` (`ID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `arena_import_rows` (
  `row_key` char(64) NOT NULL,
  `result_ID` bigint unsigned NOT NULL,
  `source_hash` char(64) NOT NULL,
  `source_revision` char(40) NOT NULL,
  `config` varchar(64) NOT NULL,
  `category` varchar(96) NOT NULL,
  `model_key` varchar(192) NOT NULL,
  `source_date` date NOT NULL,
  `ingested_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `manual_override` enum('none','edit','delete') NOT NULL DEFAULT 'none',
  PRIMARY KEY (`row_key`),
  UNIQUE KEY `uq_arena_import_result` (`result_ID`),
  CONSTRAINT `fk_arena_import_result` FOREIGN KEY (`result_ID`) REFERENCES `benchmark_results` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `arena_sync_batches` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `source_revision` char(40) NOT NULL,
  `source_modified_at` datetime(3) NOT NULL,
  `snapshot_hash` char(64) NOT NULL,
  `status` enum('running','succeeded','failed') NOT NULL DEFAULT 'running',
  `summary` json NOT NULL,
  `error_message` text,
  `started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_arena_sync_revision` (`source_revision`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `arena_sync_conflicts` (
  `row_key` char(64) NOT NULL,
  `result_ID` bigint unsigned NOT NULL,
  `incoming_hash` char(64) DEFAULT NULL,
  `incoming_row` longtext,
  `source_revision` char(40) NOT NULL,
  `config` varchar(64) NOT NULL,
  `category` varchar(96) NOT NULL,
  `status` enum('pending','accept_source') NOT NULL DEFAULT 'pending',
  `reviewed_by_user_ID` bigint unsigned DEFAULT NULL,
  `reviewed_at` datetime(3) DEFAULT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`row_key`),
  KEY `fk_arena_conflict_result` (`result_ID`),
  CONSTRAINT `fk_arena_conflict_result` FOREIGN KEY (`result_ID`) REFERENCES `benchmark_results` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `chk_arena_conflict_json` CHECK (((`incoming_row` is null) or json_valid(`incoming_row`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `arena_sync_feed_state` (
  `config` varchar(64) NOT NULL,
  `current_batch_ID` bigint unsigned NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`config`),
  KEY `fk_arena_sync_feed_batch` (`current_batch_ID`),
  CONSTRAINT `fk_arena_sync_feed_batch` FOREIGN KEY (`current_batch_ID`) REFERENCES `arena_sync_batches` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `arena_sync_state` (
  `ID` tinyint unsigned NOT NULL,
  `current_batch_ID` bigint unsigned NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  KEY `fk_arena_sync_batch` (`current_batch_ID`),
  CONSTRAINT `fk_arena_sync_batch` FOREIGN KEY (`current_batch_ID`) REFERENCES `arena_sync_batches` (`ID`),
  CONSTRAINT `chk_arena_sync_singleton` CHECK ((`ID` = 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmark_conditions` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `benchmark_ID` int unsigned NOT NULL,
  `condition_key` varchar(128) NOT NULL,
  `name` varchar(192) NOT NULL,
  `score_direction` enum('higher','lower','closer_to_target') NOT NULL,
  `target_value` decimal(18,6) DEFAULT NULL,
  `uses_percentage_scale` tinyint(1) NOT NULL,
  `score_min` decimal(18,6) DEFAULT NULL,
  `score_max` decimal(18,6) DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `deleted_at` datetime DEFAULT NULL,
  `default_marker` tinyint GENERATED ALWAYS AS ((case when (`is_default` = 1) then 1 else NULL end)) STORED,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_primary` tinyint(1) NOT NULL DEFAULT '0',
  `primary_marker` tinyint GENERATED ALWAYS AS ((case when ((`is_primary` = 1) and (`deleted_at` is null)) then 1 else NULL end)) STORED,
  `score_source` varchar(64) DEFAULT NULL,
  `difference_explanation` text,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_benchmark_conditions_key` (`benchmark_ID`,`condition_key`),
  UNIQUE KEY `uq_benchmark_conditions_default` (`benchmark_ID`,`default_marker`),
  UNIQUE KEY `uq_benchmark_condition_primary` (`benchmark_ID`,`primary_marker`),
  KEY `idx_benchmark_conditions_name` (`benchmark_ID`,`deleted_at`,`name`),
  CONSTRAINT `fk_benchmark_conditions_benchmark` FOREIGN KEY (`benchmark_ID`) REFERENCES `benchmarks` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `chk_benchmark_condition_primary` CHECK ((`is_primary` in (0,1))),
  CONSTRAINT `chk_benchmark_conditions_default` CHECK ((`is_default` in (0,1))),
  CONSTRAINT `chk_benchmark_conditions_percentage` CHECK ((`uses_percentage_scale` in (0,1))),
  CONSTRAINT `chk_benchmark_conditions_range` CHECK ((((`uses_percentage_scale` = 1) and (`score_min` is null) and (`score_max` is null)) or ((`uses_percentage_scale` = 0) and (`score_min` is not null) and (`score_max` is not null) and (`score_max` > `score_min`)))),
  CONSTRAINT `chk_benchmark_conditions_target` CHECK ((((`score_direction` = _utf8mb4'closer_to_target') and (`target_value` is not null) and ((`uses_percentage_scale` = 0) or ((`target_value` >= 0) and (`target_value` <= 100))) and ((`score_min` is null) or (`target_value` >= `score_min`)) and ((`score_max` is null) or (`target_value` <= `score_max`))) or ((`score_direction` <> _utf8mb4'closer_to_target') and (`target_value` is null)))),
  CONSTRAINT `chk_deleted_condition_not_primary` CHECK (((`deleted_at` is null) or (`is_primary` = 0)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_conditions_insert` AFTER INSERT ON `benchmark_conditions` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_conditions_update` AFTER UPDATE ON `benchmark_conditions` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_conditions_delete` AFTER DELETE ON `benchmark_conditions` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmark_families` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `primary_benchmark_condition_ID` bigint unsigned NOT NULL,
  `chain_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_family_chain` (`chain_hash`),
  UNIQUE KEY `uq_family_entrance` (`ID`,`primary_benchmark_condition_ID`),
  KEY `fk_family_primary` (`primary_benchmark_condition_ID`),
  CONSTRAINT `fk_family_primary` FOREIGN KEY (`primary_benchmark_condition_ID`) REFERENCES `benchmark_conditions` (`ID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_families_insert` AFTER INSERT ON `benchmark_families` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_families_update` AFTER UPDATE ON `benchmark_families` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_families_delete` AFTER DELETE ON `benchmark_families` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmark_family_members` (
  `family_ID` bigint unsigned NOT NULL,
  `position` int unsigned NOT NULL,
  `benchmark_condition_ID` bigint unsigned NOT NULL,
  PRIMARY KEY (`family_ID`,`position`),
  UNIQUE KEY `uq_family_member` (`family_ID`,`benchmark_condition_ID`),
  KEY `fk_family_member_condition` (`benchmark_condition_ID`),
  CONSTRAINT `fk_family_member_condition` FOREIGN KEY (`benchmark_condition_ID`) REFERENCES `benchmark_conditions` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_family_member_family` FOREIGN KEY (`family_ID`) REFERENCES `benchmark_families` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `chk_family_position` CHECK ((`position` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_family_members_insert` AFTER INSERT ON `benchmark_family_members` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_family_members_update` AFTER UPDATE ON `benchmark_family_members` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_family_members_delete` AFTER DELETE ON `benchmark_family_members` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmark_results` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `model_ID` int unsigned NOT NULL,
  `benchmark_ID` int unsigned NOT NULL,
  `benchmark_condition_ID` bigint unsigned NOT NULL,
  `raw_score` decimal(18,6) NOT NULL,
  `source_url` varchar(2048) NOT NULL,
  `source_type` enum('vendor_official','third_party_lab','paper','other') NOT NULL,
  `source_title` varchar(255) DEFAULT NULL,
  `benchmark_condition_snapshot` json NOT NULL,
  `submitted_by` bigint unsigned DEFAULT NULL,
  `moderation_log_ID` int unsigned DEFAULT NULL,
  `status` enum('accepted','superseded','archived') NOT NULL DEFAULT 'accepted',
  `accepted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `notes` text,
  `score_fields` json NOT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_benchmark_results_model_status` (`model_ID`,`status`),
  KEY `idx_benchmark_results_model_condition_status` (`status`),
  KEY `idx_benchmark_results_benchmark_status` (`benchmark_ID`,`status`),
  KEY `idx_benchmark_results_benchmark_condition_status` (`benchmark_condition_ID`,`status`),
  KEY `idx_benchmark_results_submitter` (`submitted_by`),
  KEY `idx_benchmark_results_moderation_log` (`moderation_log_ID`),
  KEY `idx_ranking_status_condition_model` (`status`,`benchmark_condition_ID`,`model_ID`),
  CONSTRAINT `fk_benchmark_results_benchmark` FOREIGN KEY (`benchmark_ID`) REFERENCES `benchmarks` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_benchmark_results_benchmark_condition` FOREIGN KEY (`benchmark_condition_ID`) REFERENCES `benchmark_conditions` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_benchmark_results_model` FOREIGN KEY (`model_ID`) REFERENCES `models` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_benchmark_results_moderation_log` FOREIGN KEY (`moderation_log_ID`) REFERENCES `moderation_logs` (`ID`) ON DELETE SET NULL,
  CONSTRAINT `fk_benchmark_results_submitter` FOREIGN KEY (`submitted_by`) REFERENCES `users` (`ID`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_results_insert` AFTER INSERT ON `benchmark_results` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_results_update` AFTER UPDATE ON `benchmark_results` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_results_delete` AFTER DELETE ON `benchmark_results` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmark_tag_links` (
  `benchmark_ID` int unsigned NOT NULL,
  `tag_ID` int unsigned NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`benchmark_ID`,`tag_ID`),
  KEY `idx_benchmark_tag_links_tag` (`tag_ID`,`benchmark_ID`),
  CONSTRAINT `fk_benchmark_tag_links_benchmark` FOREIGN KEY (`benchmark_ID`) REFERENCES `benchmarks` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_benchmark_tag_links_tag` FOREIGN KEY (`tag_ID`) REFERENCES `benchmark_tags` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_tag_links_insert` AFTER INSERT ON `benchmark_tag_links` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_tag_links_update` AFTER UPDATE ON `benchmark_tag_links` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_tag_links_delete` AFTER DELETE ON `benchmark_tag_links` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmark_tags` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `tag_key` varchar(96) NOT NULL,
  `name` varchar(96) NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_benchmark_tags_key` (`tag_key`),
  UNIQUE KEY `uq_benchmark_tags_name` (`name`),
  CONSTRAINT `chk_benchmark_tags_active` CHECK ((`is_active` in (0,1)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_tags_insert` AFTER INSERT ON `benchmark_tags` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_tags_update` AFTER UPDATE ON `benchmark_tags` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmark_tags_delete` AFTER DELETE ON `benchmark_tags` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `benchmarks` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(192) NOT NULL,
  `introduction_url` varchar(2048) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `notes` text,
  `description` text,
  `request_official_sync` tinyint(1) NOT NULL DEFAULT '0',
  `official_sync_url` varchar(2048) DEFAULT NULL,
  `official_sync_instructions` text,
  `scores_updated_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_benchmarks_name` (`name`),
  CONSTRAINT `chk_benchmarks_active` CHECK ((`is_active` in (0,1)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmarks_insert` AFTER INSERT ON `benchmarks` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmarks_update` AFTER UPDATE ON `benchmarks` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_benchmarks_delete` AFTER DELETE ON `benchmarks` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `categories` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `parent_ID` int unsigned DEFAULT NULL,
  `name` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `notes` text,
  `position` smallint unsigned NOT NULL DEFAULT '0',
  `owner_user_ID` bigint unsigned DEFAULT NULL,
  `slug` varchar(80) DEFAULT NULL,
  `description` text,
  `created_by_user_ID` bigint unsigned DEFAULT NULL,
  `public_slug` varchar(80) GENERATED ALWAYS AS ((case when (`owner_user_ID` is null) then `slug` else NULL end)) VIRTUAL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_categories_parent_name` (`parent_ID`,`name`),
  UNIQUE KEY `uq_private_category_owner_name` (`owner_user_ID`,`name`),
  UNIQUE KEY `uq_topics_public_slug` (`public_slug`),
  KEY `idx_topics_creator_created` (`created_by_user_ID`,`created_at`),
  CONSTRAINT `fk_categories_owner` FOREIGN KEY (`owner_user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_categories_parent` FOREIGN KEY (`parent_ID`) REFERENCES `categories` (`ID`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `fk_topics_creator` FOREIGN KEY (`created_by_user_ID`) REFERENCES `users` (`ID`) ON DELETE SET NULL,
  CONSTRAINT `chk_private_category_root` CHECK (((`owner_user_ID` is null) or (`parent_ID` is null))),
  CONSTRAINT `chk_topics_flat` CHECK ((`parent_ID` is null))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_categories_insert` AFTER INSERT ON `categories` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_categories_update` AFTER UPDATE ON `categories` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_categories_delete` AFTER DELETE ON `categories` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crawl_entity_mapping_evidence` (
  `package_file` varchar(64) NOT NULL,
  `record_ref` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `target_table_name` varchar(64) NOT NULL,
  `proposed_action` varchar(32) NOT NULL,
  `selected_for_import` tinyint(1) NOT NULL,
  `parent_ref` varchar(128) DEFAULT NULL,
  `vendor_ref` varchar(128) DEFAULT NULL,
  `existing_db_id` bigint unsigned DEFAULT NULL,
  `hold_reasons` json NOT NULL,
  `source_payload` json NOT NULL,
  `source_payload_raw` longtext NOT NULL,
  `payload_sha256` binary(32) NOT NULL,
  `imported_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`package_file`,`record_ref`),
  KEY `idx_mapping_target` (`target_table_name`,`proposed_action`),
  KEY `idx_mapping_selected` (`selected_for_import`),
  KEY `idx_mapping_parent` (`parent_ref`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crawl_object_evidence` (
  `object_id` varchar(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `kind` varchar(80) NOT NULL,
  `name` varchar(512) DEFAULT NULL,
  `canonical_id` varchar(256) DEFAULT NULL,
  `identity_group` varchar(256) DEFAULT NULL,
  `source_payload` json NOT NULL,
  `source_payload_raw` longtext NOT NULL,
  `payload_sha256` binary(32) NOT NULL,
  `imported_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`object_id`),
  KEY `idx_crawl_object_kind` (`kind`),
  KEY `idx_crawl_object_canonical` (`canonical_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crawl_observation_evidence` (
  `score_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `source_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `model_object_id` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `benchmark_object_id` varchar(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `raw_score_text` text,
  `source_url` text,
  `disposition` varchar(32) NOT NULL,
  `review_reasons` json NOT NULL,
  `primary_score_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `source_payload` json NOT NULL,
  `source_payload_raw` longtext NOT NULL,
  `payload_sha256` binary(32) NOT NULL,
  `imported_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `reviewed_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`score_id`),
  KEY `idx_crawl_evidence_source` (`source_id`,`disposition`),
  KEY `idx_crawl_evidence_model` (`model_object_id`),
  KEY `idx_crawl_evidence_benchmark` (`benchmark_object_id`),
  KEY `idx_crawl_evidence_disposition` (`disposition`),
  CONSTRAINT `chk_crawl_evidence_disposition` CHECK ((`disposition` in (_utf8mb4'ready',_utf8mb4'held',_utf8mb4'condition_review',_utf8mb4'excluded',_utf8mb4'duplicate_evidence')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `crawl_state_metadata` (
  `section` varchar(80) NOT NULL,
  `item_key` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `source_file_sha256` binary(32) NOT NULL,
  `source_payload` json NOT NULL,
  `source_payload_raw` longtext NOT NULL,
  `payload_sha256` binary(32) NOT NULL,
  `imported_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`section`,`item_key`),
  KEY `idx_crawl_metadata_source` (`source_file_sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `discussion_mentions` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `post_ID` bigint unsigned NOT NULL,
  `benchmark_ID` int unsigned DEFAULT NULL,
  `condition_ID` bigint unsigned DEFAULT NULL,
  `label` varchar(600) NOT NULL,
  PRIMARY KEY (`ID`),
  KEY `discussion_benchmark` (`benchmark_ID`,`post_ID`),
  KEY `post_ID` (`post_ID`),
  KEY `condition_ID` (`condition_ID`),
  CONSTRAINT `discussion_mentions_ibfk_1` FOREIGN KEY (`post_ID`) REFERENCES `discussion_posts` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `discussion_mentions_ibfk_2` FOREIGN KEY (`benchmark_ID`) REFERENCES `benchmarks` (`ID`) ON DELETE SET NULL,
  CONSTRAINT `discussion_mentions_ibfk_3` FOREIGN KEY (`condition_ID`) REFERENCES `benchmark_conditions` (`ID`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `discussion_posts` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `category_ID` int unsigned NOT NULL,
  `context_ID` bigint unsigned NOT NULL,
  `author_ID` bigint unsigned DEFAULT NULL,
  `parent_ID` bigint unsigned DEFAULT NULL,
  `body` text NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `hidden_at` datetime(3) DEFAULT NULL,
  `deleted_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  KEY `discussion_feed` (`category_ID`,`parent_ID`,`hidden_at`,`created_at`),
  KEY `discussion_author_time` (`author_ID`,`created_at`),
  KEY `discussion_replies` (`parent_ID`,`hidden_at`,`created_at`),
  KEY `context_ID` (`context_ID`),
  CONSTRAINT `discussion_posts_ibfk_1` FOREIGN KEY (`category_ID`) REFERENCES `categories` (`ID`),
  CONSTRAINT `discussion_posts_ibfk_2` FOREIGN KEY (`context_ID`) REFERENCES `ranking_contexts` (`ID`),
  CONSTRAINT `discussion_posts_ibfk_3` FOREIGN KEY (`author_ID`) REFERENCES `users` (`ID`) ON DELETE SET NULL,
  CONSTRAINT `discussion_posts_ibfk_4` FOREIGN KEY (`parent_ID`) REFERENCES `discussion_posts` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `discussion_votes` (
  `post_ID` bigint unsigned NOT NULL,
  `user_ID` bigint unsigned NOT NULL,
  `value` tinyint NOT NULL,
  PRIMARY KEY (`post_ID`,`user_ID`),
  KEY `user_ID` (`user_ID`),
  CONSTRAINT `discussion_votes_ibfk_1` FOREIGN KEY (`post_ID`) REFERENCES `discussion_posts` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `discussion_votes_ibfk_2` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `discussion_votes_chk_1` CHECK ((`value` in (-(1),1)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `model_parameter_migration_archive` (
  `model_ID` bigint unsigned NOT NULL,
  `snapshot` json NOT NULL,
  `archived_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`model_ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `models` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `vendor_ID` int unsigned NOT NULL,
  `slug` varchar(128) NOT NULL,
  `name` varchar(192) NOT NULL,
  `introduction_url` varchar(2048) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `notes` text,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_models_slug` (`slug`),
  UNIQUE KEY `uq_models_vendor_name` (`vendor_ID`,`name`),
  KEY `idx_models_active_name` (`is_active`,`name`),
  CONSTRAINT `fk_models_organization` FOREIGN KEY (`vendor_ID`) REFERENCES `organizations` (`ID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_models_insert` AFTER INSERT ON `models` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_models_update` AFTER UPDATE ON `models` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_models_delete` AFTER DELETE ON `models` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `moderation_audit_logs` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `moderation_log_ID` int unsigned DEFAULT NULL,
  `reviewer_user_ID` bigint unsigned NOT NULL,
  `action_type` varchar(48) NOT NULL,
  `request_type` varchar(64) NOT NULL,
  `request_summary` varchar(255) NOT NULL,
  `status_before` varchar(32) NOT NULL,
  `status_after` varchar(32) NOT NULL,
  `request_before` json NOT NULL,
  `request_after` json DEFAULT NULL,
  `executed_sql` longtext NOT NULL,
  `database_response` json NOT NULL,
  `outcome` enum('success','failure') NOT NULL,
  `duration_ms` int unsigned NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  KEY `idx_moderation_audit_log_created` (`moderation_log_ID`,`created_at`),
  KEY `idx_moderation_audit_action_created` (`action_type`,`created_at`),
  KEY `idx_moderation_audit_user_created` (`reviewer_user_ID`,`created_at`),
  CONSTRAINT `fk_moderation_audit_log` FOREIGN KEY (`moderation_log_ID`) REFERENCES `moderation_logs` (`ID`) ON DELETE SET NULL,
  CONSTRAINT `fk_moderation_audit_reviewer_user` FOREIGN KEY (`reviewer_user_ID`) REFERENCES `users` (`ID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `moderation_email_outbox` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `moderation_log_ID` int unsigned NOT NULL,
  `user_ID` bigint unsigned NOT NULL,
  `recipient_email` varchar(320) DEFAULT NULL,
  `decision` enum('approved','rejected') NOT NULL,
  `contribution_type` varchar(64) NOT NULL,
  `delivery_status` enum('pending','sending','sent','failed') NOT NULL DEFAULT 'pending',
  `attempt_count` smallint unsigned NOT NULL DEFAULT '0',
  `next_attempt_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3),
  `locked_at` datetime(3) DEFAULT NULL,
  `sent_at` datetime(3) DEFAULT NULL,
  `last_error` varchar(1000) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_moderation_email_outbox_log` (`moderation_log_ID`),
  KEY `idx_moderation_email_outbox_delivery` (`delivery_status`,`next_attempt_at`),
  KEY `idx_moderation_email_outbox_user` (`user_ID`,`created_at`),
  CONSTRAINT `fk_moderation_email_outbox_log` FOREIGN KEY (`moderation_log_ID`) REFERENCES `moderation_logs` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_moderation_email_outbox_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `moderation_logs` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `content` json NOT NULL,
  `report_count` int unsigned NOT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `user_id` bigint unsigned NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  KEY `idx_moderation_status_created` (`status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organizations` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `slug` varchar(96) NOT NULL,
  `name` varchar(128) NOT NULL,
  `logo_key` varchar(96) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_model_vendor` tinyint(1) NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `introduction_url` varchar(2048) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_vendors_slug` (`slug`),
  UNIQUE KEY `uq_vendors_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_organizations_insert` AFTER INSERT ON `organizations` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_organizations_update` AFTER UPDATE ON `organizations` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_organizations_delete` AFTER DELETE ON `organizations` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `personal_pie_score_rules` (
  `pie_ID` bigint unsigned NOT NULL,
  `primary_benchmark_condition_ID` bigint unsigned NOT NULL,
  `family_ID` bigint unsigned DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `selection_source` enum('selected','custom') NOT NULL DEFAULT 'selected',
  PRIMARY KEY (`pie_ID`,`primary_benchmark_condition_ID`),
  KEY `fk_ordered_rule_family` (`family_ID`,`primary_benchmark_condition_ID`),
  CONSTRAINT `fk_ordered_rule_family` FOREIGN KEY (`family_ID`, `primary_benchmark_condition_ID`) REFERENCES `benchmark_families` (`ID`, `primary_benchmark_condition_ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_ordered_rule_weight` FOREIGN KEY (`pie_ID`, `primary_benchmark_condition_ID`) REFERENCES `personal_pie_weights` (`pie_ID`, `benchmark_condition_ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pie_score_rules_insert` AFTER INSERT ON `personal_pie_score_rules` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pie_score_rules_update` AFTER UPDATE ON `personal_pie_score_rules` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pie_score_rules_delete` AFTER DELETE ON `personal_pie_score_rules` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `personal_pie_topic_weights` (
  `pie_ID` bigint unsigned NOT NULL,
  `target_context_ID` bigint unsigned NOT NULL,
  `weight_basis_points` smallint unsigned NOT NULL,
  PRIMARY KEY (`pie_ID`,`target_context_ID`),
  KEY `idx_topic_weight_target` (`target_context_ID`),
  CONSTRAINT `fk_topic_weight_context` FOREIGN KEY (`target_context_ID`) REFERENCES `ranking_contexts` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_topic_weight_pie` FOREIGN KEY (`pie_ID`) REFERENCES `personal_pies` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `ck_topic_weight_basis_points` CHECK ((`weight_basis_points` between 100 and 10000))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `scene_cache_reference_insert` AFTER INSERT ON `personal_pie_topic_weights` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `scene_cache_reference_update` AFTER UPDATE ON `personal_pie_topic_weights` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `scene_cache_reference_delete` AFTER DELETE ON `personal_pie_topic_weights` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `personal_pie_weights` (
  `pie_ID` bigint unsigned NOT NULL,
  `benchmark_condition_ID` bigint unsigned NOT NULL,
  `weight_basis_points` smallint unsigned NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`pie_ID`,`benchmark_condition_ID`),
  KEY `idx_personal_pie_weights_condition` (`benchmark_condition_ID`),
  CONSTRAINT `fk_personal_pie_weights_condition` FOREIGN KEY (`benchmark_condition_ID`) REFERENCES `benchmark_conditions` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_personal_pie_weights_pie` FOREIGN KEY (`pie_ID`) REFERENCES `personal_pies` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `chk_personal_pie_weight_basis_points` CHECK (((`weight_basis_points` >= 100) and (`weight_basis_points` <= 10000)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pie_weights_insert` AFTER INSERT ON `personal_pie_weights` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pie_weights_update` AFTER UPDATE ON `personal_pie_weights` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pie_weights_delete` AFTER DELETE ON `personal_pie_weights` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `personal_pies` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_ID` bigint unsigned NOT NULL,
  `context_ID` bigint unsigned NOT NULL,
  `revision` int unsigned NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_personal_pie_user_context` (`user_ID`,`context_ID`),
  KEY `idx_personal_pie_context` (`context_ID`),
  CONSTRAINT `fk_personal_pie_context` FOREIGN KEY (`context_ID`) REFERENCES `ranking_contexts` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_personal_pie_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pies_insert` AFTER INSERT ON `personal_pies` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pies_update` AFTER UPDATE ON `personal_pies` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_personal_pies_delete` AFTER DELETE ON `personal_pies` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `privacy_preference_events` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_ID` bigint unsigned NOT NULL,
  `research_version` varchar(32) NOT NULL,
  `enabled` tinyint unsigned NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  KEY `privacy_preference_user` (`user_ID`,`created_at`),
  CONSTRAINT `privacy_preference_events_ibfk_1` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `privacy_requests` (
  `reference` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `user_ID` bigint unsigned DEFAULT NULL,
  `email` varchar(320) NOT NULL,
  `request_type` enum('access','correction','erasure','objection','other') NOT NULL,
  `message` text NOT NULL,
  `status` enum('open','in_review','closed') NOT NULL DEFAULT 'open',
  `resolution` text NOT NULL,
  `handled_by` bigint unsigned DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `due_at` datetime(3) NOT NULL,
  PRIMARY KEY (`reference`),
  KEY `privacy_request_page` (`created_at`,`reference`),
  KEY `privacy_request_status` (`status`,`due_at`),
  KEY `user_ID` (`user_ID`),
  KEY `handled_by` (`handled_by`),
  CONSTRAINT `privacy_requests_ibfk_1` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE SET NULL,
  CONSTRAINT `privacy_requests_ibfk_2` FOREIGN KEY (`handled_by`) REFERENCES `users` (`ID`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ranking_cache_revisions` (
  `ID` tinyint unsigned NOT NULL,
  `epoch` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `data_revision` bigint unsigned NOT NULL DEFAULT '0',
  `catalogue_revision` bigint unsigned NOT NULL DEFAULT '0',
  `ready` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ranking_contexts` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `category_ID` int unsigned NOT NULL,
  `context_values` json NOT NULL,
  `context_hash` char(64) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_ranking_context_category_hash` (`category_ID`,`context_hash`),
  UNIQUE KEY `uq_ranking_context_identity` (`ID`,`category_ID`),
  CONSTRAINT `fk_ranking_context_category` FOREIGN KEY (`category_ID`) REFERENCES `categories` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_ranking_contexts_insert` AFTER INSERT ON `ranking_contexts` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_ranking_contexts_update` AFTER UPDATE ON `ranking_contexts` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_ranking_contexts_delete` AFTER DELETE ON `ranking_contexts` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ranking_dimension_options` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `dimension_ID` int unsigned NOT NULL,
  `option_key` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `position` smallint unsigned NOT NULL DEFAULT '0',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `is_neutral` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_ranking_dimension_options_key` (`dimension_ID`,`option_key`),
  KEY `idx_ranking_dimension_options_position` (`dimension_ID`,`position`),
  CONSTRAINT `fk_ranking_dimension_options_dimension` FOREIGN KEY (`dimension_ID`) REFERENCES `ranking_dimensions` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ranking_dimensions` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `scope_category_ID` int unsigned NOT NULL DEFAULT '0' COMMENT '0 means globally available',
  `dimension_key` varchar(64) NOT NULL,
  `name` varchar(128) NOT NULL,
  `position` smallint unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `notes` text,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_ranking_dimensions_scope_key` (`scope_category_ID`,`dimension_key`),
  KEY `idx_ranking_dimensions_scope_position` (`scope_category_ID`,`is_active`,`position`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `recent_model_archive_items` (
  `batch_id` varchar(64) NOT NULL,
  `entity_type` varchar(32) NOT NULL,
  `object_id` bigint unsigned NOT NULL,
  `original_state` json NOT NULL,
  `reason` varchar(64) NOT NULL,
  PRIMARY KEY (`batch_id`,`entity_type`,`object_id`),
  CONSTRAINT `fk_recent_model_archive_batch` FOREIGN KEY (`batch_id`) REFERENCES `recent_model_archive_runs` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `recent_model_archive_restorations` (
  `batch_id` varchar(64) NOT NULL,
  `restore_label` varchar(64) NOT NULL,
  `model_ids` json NOT NULL,
  `condition_count` int unsigned NOT NULL,
  `result_count` int unsigned NOT NULL,
  `benchmark_count` int unsigned NOT NULL,
  `restored_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`,`restore_label`),
  CONSTRAINT `fk_recent_model_archive_restoration_batch` FOREIGN KEY (`batch_id`) REFERENCES `recent_model_archive_runs` (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `recent_model_archive_runs` (
  `batch_id` varchar(64) NOT NULL,
  `cutoff_date` date NOT NULL,
  `plan_sha256` char(64) NOT NULL,
  `backup_path` varchar(512) NOT NULL,
  `backup_sha256` char(64) NOT NULL,
  `condition_count` int unsigned NOT NULL,
  `benchmark_count` int unsigned NOT NULL,
  `result_count` int unsigned NOT NULL,
  `archived_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `run_field_preset_migration_archive` (
  `migration_id` varchar(128) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `run_id` char(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `kind` varchar(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  `object_key` varchar(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `before_snapshot` json DEFAULT NULL,
  `after_snapshot` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`migration_id`,`run_id`,`kind`,`object_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci ROW_FORMAT=DYNAMIC;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_migrations` (
  `migration_id` varchar(128) NOT NULL,
  `applied_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`migration_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_field_migration_archive` (
  `kind` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  `object_ID` bigint unsigned NOT NULL,
  `snapshot` json NOT NULL,
  PRIMARY KEY (`kind`,`object_ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_field_options` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `field_ID` bigint unsigned NOT NULL,
  `label` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `label_key` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `excluded` tinyint(1) NOT NULL DEFAULT '0',
  `revision` int unsigned NOT NULL DEFAULT '1',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_request_ID` bigint unsigned DEFAULT NULL,
  `created_option_index` int unsigned DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `field_label` (`field_ID`,`label_key`),
  KEY `created_request_ID` (`created_request_ID`),
  CONSTRAINT `score_field_options_ibfk_1` FOREIGN KEY (`field_ID`) REFERENCES `score_fields` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_score_field_options_insert` AFTER INSERT ON `score_field_options` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_score_field_options_update` AFTER UPDATE ON `score_field_options` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_score_field_options_delete` AFTER DELETE ON `score_field_options` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_fields` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(80) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name_key` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `field_type` enum('presence','text','number','enum') COLLATE utf8mb4_unicode_ci NOT NULL,
  `allow_empty` tinyint(1) NOT NULL DEFAULT '0',
  `exclude_missing` tinyint(1) NOT NULL DEFAULT '1',
  `exclude_empty` tinyint(1) NOT NULL DEFAULT '0',
  `revision` int unsigned NOT NULL DEFAULT '1',
  `is_active` tinyint(1) NOT NULL DEFAULT '1',
  `created_request_ID` bigint unsigned DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `name_key` (`name_key`),
  KEY `created_request_ID` (`created_request_ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_score_fields_insert` AFTER INSERT ON `score_fields` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_score_fields_update` AFTER UPDATE ON `score_fields` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_score_fields_delete` AFTER DELETE ON `score_fields` FOR EACH ROW UPDATE ranking_cache_revisions SET data_revision = data_revision + 1 WHERE ID = 1 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_provider_retirement_archive` (
  `entity_type` varchar(32) NOT NULL,
  `entity_id` bigint unsigned NOT NULL,
  `snapshot` json NOT NULL,
  `archived_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`entity_type`,`entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_sync_jobs` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `source_key` varchar(64) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT '1',
  `interval_seconds` int unsigned NOT NULL,
  `next_run_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_status` enum('never','running','succeeded','partial','failed') NOT NULL DEFAULT 'never',
  `registered_by` varchar(192) NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  UNIQUE KEY `source_key` (`source_key`),
  CONSTRAINT `chk_score_sync_interval` CHECK ((`interval_seconds` between 3600 and 604800))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_sync_registry_events` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `job_ID` bigint unsigned NOT NULL,
  `operator` varchar(192) NOT NULL,
  `configuration` json NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`ID`),
  KEY `fk_score_sync_registry_job` (`job_ID`),
  CONSTRAINT `fk_score_sync_registry_job` FOREIGN KEY (`job_ID`) REFERENCES `score_sync_jobs` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `score_sync_runs` (
  `ID` bigint unsigned NOT NULL AUTO_INCREMENT,
  `job_ID` bigint unsigned NOT NULL,
  `status` enum('running','succeeded','partial','failed') NOT NULL DEFAULT 'running',
  `source_revision` varchar(40) DEFAULT NULL,
  `summary` json DEFAULT NULL,
  `error_message` text,
  `started_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completed_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  KEY `idx_score_sync_runs_job` (`job_ID`,`started_at`),
  CONSTRAINT `fk_score_sync_run_job` FOREIGN KEY (`job_ID`) REFERENCES `score_sync_jobs` (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `sessions` (
  `session_id` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `expires` int unsigned NOT NULL,
  `data` mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topic_legacy_routes` (
  `route_hash` binary(32) NOT NULL,
  `route_key` varchar(2048) NOT NULL,
  `category_ID` int unsigned NOT NULL,
  PRIMARY KEY (`route_hash`),
  KEY `fk_topic_legacy_category` (`category_ID`),
  CONSTRAINT `fk_topic_legacy_category` FOREIGN KEY (`category_ID`) REFERENCES `categories` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topic_migration_archive` (
  `migration_id` varchar(128) NOT NULL,
  `payload` json NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`migration_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topic_proposal_votes` (
  `proposal_ID` int unsigned NOT NULL,
  `user_ID` bigint unsigned NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`proposal_ID`,`user_ID`),
  KEY `idx_topic_proposal_vote_user` (`user_ID`,`proposal_ID`),
  CONSTRAINT `fk_topic_proposal_vote_proposal` FOREIGN KEY (`proposal_ID`) REFERENCES `topic_proposals` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `fk_topic_proposal_vote_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topic_proposals` (
  `ID` int unsigned NOT NULL AUTO_INCREMENT,
  `user_ID` bigint unsigned NOT NULL,
  `name` varchar(128) NOT NULL,
  `slug` varchar(80) NOT NULL,
  `description` varchar(180) NOT NULL,
  `status` enum('open','pending','approved','rejected') NOT NULL DEFAULT 'open',
  `moderation_log_ID` int unsigned DEFAULT NULL,
  `topic_ID` int unsigned DEFAULT NULL,
  `promoted_at` datetime(3) DEFAULT NULL,
  `decided_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `revision` int unsigned NOT NULL DEFAULT '1',
  `withdrawn_at` datetime(3) DEFAULT NULL,
  `reservation_slug` varchar(80) DEFAULT NULL,
  `reservation_name` varchar(128) DEFAULT NULL,
  `parent_topic_ID` int unsigned DEFAULT NULL,
  `scene_context_ID` bigint unsigned DEFAULT NULL,
  `scene_reservation_slug` varchar(80) DEFAULT NULL,
  `scene_reservation_name` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`ID`),
  UNIQUE KEY `uq_topic_proposal_moderation` (`moderation_log_ID`),
  UNIQUE KEY `uq_topic_proposal_topic` (`topic_ID`),
  UNIQUE KEY `uq_topic_proposal_reservation_slug` (`reservation_slug`),
  UNIQUE KEY `uq_topic_proposal_reservation_name` (`reservation_name`),
  UNIQUE KEY `uq_scene_proposal_context` (`scene_context_ID`),
  UNIQUE KEY `uq_scene_proposal_slug` (`parent_topic_ID`,`scene_reservation_slug`),
  UNIQUE KEY `uq_scene_proposal_name` (`parent_topic_ID`,`scene_reservation_name`),
  KEY `idx_topic_proposal_user` (`user_ID`,`created_at`),
  KEY `fk_scene_proposal_context` (`scene_context_ID`,`parent_topic_ID`),
  CONSTRAINT `fk_scene_proposal_category` FOREIGN KEY (`parent_topic_ID`) REFERENCES `categories` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_scene_proposal_context` FOREIGN KEY (`scene_context_ID`, `parent_topic_ID`) REFERENCES `ranking_contexts` (`ID`, `category_ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_topic_proposal_moderation` FOREIGN KEY (`moderation_log_ID`) REFERENCES `moderation_logs` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_topic_proposal_topic` FOREIGN KEY (`topic_ID`) REFERENCES `categories` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_topic_proposal_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `ck_scene_proposal_identity` CHECK ((((`parent_topic_ID` is null) and (`scene_context_ID` is null) and (`scene_reservation_slug` is null) and (`scene_reservation_name` is null)) or ((`parent_topic_ID` is not null) and (`topic_ID` is null) and (`reservation_slug` is null) and (`reservation_name` is null)))),
  CONSTRAINT `ck_topic_proposal_state` CHECK ((((`status` = _utf8mb4'open') and (`moderation_log_ID` is null) and (`topic_ID` is null) and (`scene_context_ID` is null) and (`promoted_at` is null) and (`decided_at` is null)) or ((`status` = _utf8mb4'pending') and (`moderation_log_ID` is not null) and (`topic_ID` is null) and (`scene_context_ID` is null) and (`promoted_at` is not null) and (`decided_at` is null)) or ((`status` = _utf8mb4'approved') and (`moderation_log_ID` is not null) and (`promoted_at` is not null) and (`decided_at` is not null) and (((`parent_topic_ID` is null) and (`topic_ID` is not null) and (`scene_context_ID` is null)) or ((`parent_topic_ID` is not null) and (`topic_ID` is null) and (`scene_context_ID` is not null)))) or ((`status` = _utf8mb4'rejected') and (`moderation_log_ID` is not null) and (`topic_ID` is null) and (`scene_context_ID` is null) and (`promoted_at` is not null) and (`decided_at` is not null))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topic_reference_lock` (
  `ID` tinyint unsigned NOT NULL,
  PRIMARY KEY (`ID`),
  CONSTRAINT `ck_topic_reference_singleton` CHECK ((`ID` = 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `topic_scenes` (
  `context_ID` bigint unsigned NOT NULL,
  `category_ID` int unsigned NOT NULL,
  `name` varchar(128) NOT NULL,
  `slug` varchar(80) NOT NULL,
  `description` varchar(180) NOT NULL,
  `position` int unsigned NOT NULL DEFAULT '0',
  `is_default` tinyint unsigned NOT NULL DEFAULT '0',
  `is_active` tinyint unsigned NOT NULL DEFAULT '1',
  `legacy_context_values` json DEFAULT NULL,
  `default_category_ID` int unsigned GENERATED ALWAYS AS ((case when ((`is_default` = 1) and (`is_active` = 1)) then `category_ID` else NULL end)) STORED,
  PRIMARY KEY (`context_ID`),
  UNIQUE KEY `uq_topic_scene_slug` (`category_ID`,`slug`),
  UNIQUE KEY `uq_topic_scene_name` (`category_ID`,`name`),
  UNIQUE KEY `uq_topic_scene_default` (`default_category_ID`),
  KEY `idx_topic_scene_order` (`category_ID`,`is_active`,`is_default`,`position`),
  KEY `fk_topic_scene_context` (`context_ID`,`category_ID`),
  CONSTRAINT `fk_topic_scene_category` FOREIGN KEY (`category_ID`) REFERENCES `categories` (`ID`) ON DELETE RESTRICT,
  CONSTRAINT `fk_topic_scene_context` FOREIGN KEY (`context_ID`, `category_ID`) REFERENCES `ranking_contexts` (`ID`, `category_ID`) ON DELETE RESTRICT,
  CONSTRAINT `ck_topic_scene_active` CHECK (((`is_active` in (0,1)) and (`is_default` in (0,1)) and ((`is_default` = 0) or (`is_active` = 1))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `scene_cache_scene_insert` AFTER INSERT ON `topic_scenes` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `scene_cache_scene_update` AFTER UPDATE ON `topic_scenes` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `scene_cache_scene_delete` AFTER DELETE ON `topic_scenes` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_comparison_profiles` (
  `user_ID` bigint unsigned NOT NULL,
  `profile_key` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `name` varchar(80) NOT NULL,
  `comparison` json NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_ID`,`profile_key`),
  CONSTRAINT `fk_comparison_profile_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_legal_acceptances` (
  `user_ID` bigint unsigned NOT NULL,
  `terms_version` varchar(32) NOT NULL,
  `privacy_version` varchar(32) NOT NULL,
  `terms_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `privacy_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `eligible_age` tinyint unsigned NOT NULL,
  `accepted_at` datetime(3) NOT NULL,
  PRIMARY KEY (`user_ID`,`terms_version`,`privacy_version`),
  CONSTRAINT `user_legal_acceptances_ibfk_1` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_privacy_preferences` (
  `user_ID` bigint unsigned NOT NULL,
  `private_category_research` tinyint unsigned NOT NULL DEFAULT '0',
  `research_version` varchar(32) NOT NULL,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`user_ID`),
  CONSTRAINT `user_privacy_preferences_ibfk_1` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_public_profiles` (
  `user_ID` bigint unsigned NOT NULL,
  `display_name` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `avatar_data_url` mediumtext CHARACTER SET ascii COLLATE ascii_bin,
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `github_username` varchar(39) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `show_github_profile` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`user_ID`),
  CONSTRAINT `fk_public_profile_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE,
  CONSTRAINT `chk_public_profile_avatar_size` CHECK (((`avatar_data_url` is null) or (length(`avatar_data_url`) <= 307200)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user_sessions` (
  `session_ID` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `user_ID` bigint unsigned NOT NULL,
  PRIMARY KEY (`session_ID`),
  KEY `fk_user_sessions_user` (`user_ID`),
  CONSTRAINT `fk_user_sessions_session` FOREIGN KEY (`session_ID`) REFERENCES `sessions` (`session_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_user_sessions_user` FOREIGN KEY (`user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `ID` bigint unsigned NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `role` enum('user','reviewer','senior') NOT NULL DEFAULT 'user',
  `profile_picture_URL` varchar(255) NOT NULL,
  `email` varchar(320) DEFAULT NULL,
  `email_verified_at` datetime(3) DEFAULT NULL,
  `followers_count` int unsigned NOT NULL,
  `deleted_at` timestamp NULL DEFAULT NULL,
  `banned_at` timestamp NULL DEFAULT NULL,
  `banned_until` timestamp NULL DEFAULT NULL,
  `banned_reason` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_users_insert` AFTER INSERT ON `users` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_users_update` AFTER UPDATE ON `users` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!50003 SET @saved_cs_client      = @@character_set_client */ ;
/*!50003 SET @saved_cs_results     = @@character_set_results */ ;
/*!50003 SET @saved_col_connection = @@collation_connection */ ;
/*!50003 SET character_set_client  = utf8mb4 */ ;
/*!50003 SET character_set_results = utf8mb4 */ ;
/*!50003 SET collation_connection  = utf8mb4_unicode_ci */ ;
/*!50003 SET @saved_sql_mode       = @@sql_mode */ ;
/*!50003 SET sql_mode              = 'IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' */ ;
DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER `bp_rank_users_delete` AFTER DELETE ON `users` FOR EACH ROW UPDATE ranking_cache_revisions SET catalogue_revision = catalogue_revision + 1 WHERE ID = 2 */;;
DELIMITER ;
/*!50003 SET sql_mode              = @saved_sql_mode */ ;
/*!50003 SET character_set_client  = @saved_cs_client */ ;
/*!50003 SET character_set_results = @saved_cs_results */ ;
/*!50003 SET collation_connection  = @saved_col_connection */ ;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `write_requests` (
  `actor_user_ID` bigint unsigned NOT NULL,
  `request_key` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `action` varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `payload_hash` char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `owner_token` char(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `response_status` smallint unsigned DEFAULT NULL,
  `response_body` json DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`actor_user_ID`,`request_key`),
  CONSTRAINT `fk_write_requests_actor` FOREIGN KEY (`actor_user_ID`) REFERENCES `users` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

